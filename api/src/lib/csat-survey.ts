// CSAT survey dispatcher. Triggered when a ticket transitions to
// resolved (see tickets.ts PATCH). Generates a one-shot token,
// stamps csat_requested_at, and sends a short Postmark email with a
// link to the portal's CSAT page.
//
// Skipped silently when:
//   - the ticket is already pending a survey (csat_requested_at set)
//   - the ticket already has a CSAT response
//   - the customer has no email
//   - Postmark isn't configured for the workspace
//
// All these are non-errors — they're the "this workspace hasn't
// wired up outbound" or "we already asked" paths, which shouldn't
// break the PATCH that resolves the ticket.

import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.ts';
import { sendEmail, isPostmarkConfigured, PostmarkSendError } from './postmark-outbound.ts';
import { getOutboundFrom } from './outbound-from.ts';

export type CsatSurveyResult =
  | { sent: true;  token: string }
  | { sent: false; reason: 'already_requested' | 'already_rated' | 'no_email' | 'postmark_not_configured' | 'no_from' | 'no_workspace' | 'send_failed'; detail?: string };

export async function sendCsatSurvey(args: {
  sb:          SupabaseClient;
  workspaceId: string;
  ticketId:    string;
  portalBase?: string;
}): Promise<CsatSurveyResult> {
  const { sb, workspaceId, ticketId } = args;
  if (!isPostmarkConfigured()) return { sent: false, reason: 'postmark_not_configured' };

  // One round-trip pulls everything we need: ticket state + customer +
  // workspace name + slug. Workspace + customer embeds resolve via FKs.
  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .select(`
      id, display_id, subject, csat_requested_at, csat_submitted_at, csat_token,
      customers(first_name, last_name, email),
      workspaces(name, slug)
    `)
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr || !ticket) return { sent: false, reason: 'no_workspace' };
  const t = ticket as any;
  if (t.csat_submitted_at)   return { sent: false, reason: 'already_rated' };
  if (t.csat_requested_at)   return { sent: false, reason: 'already_requested' };
  const customer = t.customers || {};
  const customerEmail = customer.email;
  if (!customerEmail) return { sent: false, reason: 'no_email' };
  const workspaceName = t.workspaces?.name || 'Support';
  const workspaceSlug = t.workspaces?.slug;
  if (!workspaceSlug) return { sent: false, reason: 'no_workspace' };

  // Generate the customer-link token first. We commit it to the row
  // before sending so the survey URL is valid the moment the email
  // lands. Reusing an existing token (idempotent on retry) keeps the
  // link stable if the email is sent twice for some reason.
  const token = t.csat_token || generateToken();

  // Outbound identity: brand-owned verified domain if configured,
  // else the platform default. Skipping here on no-from would mean
  // sending from nothing, so bail cleanly.
  const workspaceFrom = await getOutboundFrom(sb, workspaceId);
  const fromEmail = workspaceFrom?.fromEmail || env.POSTMARK_OUTBOUND_FROM;
  const fromName  = workspaceFrom?.fromName  || workspaceName;
  if (!fromEmail) return { sent: false, reason: 'no_from' };

  // Portal base URL. Prefer the explicit arg (handy for tests),
  // then PORTAL_BASE_URL env var (production), then the dev fallback.
  const portalBase = args.portalBase || env.PORTAL_BASE_URL || 'http://localhost:5173/portal.html';
  const surveyUrl  = `${portalBase}?ws=${encodeURIComponent(workspaceSlug)}&csat=${encodeURIComponent(token)}`;
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'there';
  const subject = `How did we do? · ${t.display_id}`;
  const textBody = [
    `Hi ${customerName},`,
    '',
    `Your support ticket "${t.subject}" has been resolved. Could you take a moment to rate the experience? It really helps us improve.`,
    '',
    surveyUrl,
    '',
    `Thanks,`,
    workspaceName,
  ].join('\n');

  try {
    await sendEmail({
      to: customerEmail,
      subject,
      textBody,
      fromEmail,
      fromName,
      replyTo: env.POSTMARK_INBOUND_REPLY_ADDRESS || null,
    });
  } catch (err) {
    const detail = err instanceof PostmarkSendError
      ? `code=${err.code} status=${err.httpStatus}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.warn(`[csat-survey] Postmark send failed for ticket ${ticketId}: ${detail}`);
    return { sent: false, reason: 'send_failed', detail };
  }

  // Stamp the request only AFTER a successful send — keeps retries
  // possible if Postmark transiently fails (the next resolve event
  // or a manual trigger can retry without bouncing off the
  // "already_requested" guard).
  await sb
    .from('tickets')
    .update({
      csat_token:        token,
      csat_requested_at: new Date().toISOString(),
    })
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId);

  return { sent: true, token };
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

// ─── Reminder worker ─────────────────────────────────────────────────────
//
// Periodic sweep: find tickets whose CSAT was requested 3+ days ago but
// not yet rated and not yet reminded, then send one more email. v1 caps
// at a single reminder per ticket — aggressive chasing reads as spam.
// The column itself supports adding more reminders later (timestamptz,
// not a count) without a schema change.

const REMINDER_AGE_DAYS = 3;
const REMINDER_TICK_MS  = 60 * 60 * 1000;  // every hour
let reminderTimer: ReturnType<typeof setInterval> | null = null;

export async function processCsatReminders(sb: SupabaseClient, portalBase?: string): Promise<number> {
  if (!isPostmarkConfigured()) return 0;
  const cutoff = new Date(Date.now() - REMINDER_AGE_DAYS * 86400000).toISOString();
  const { data: candidates, error } = await sb
    .from('tickets')
    .select('id, workspace_id')
    .is('csat_submitted_at', null)
    .is('csat_last_reminded_at', null)
    .not('csat_requested_at', 'is', null)
    .not('csat_token', 'is', null)
    .is('deleted_at', null)
    .lte('csat_requested_at', cutoff)
    .limit(100);
  if (error) {
    console.error('[csat-reminders] scan failed:', error.message);
    return 0;
  }
  if (!candidates || candidates.length === 0) return 0;

  let sentCount = 0;
  for (const row of candidates) {
    try {
      const ok = await sendOneReminder({ sb, workspaceId: row.workspace_id, ticketId: row.id, portalBase });
      if (ok) sentCount++;
    } catch (err) {
      console.warn(`[csat-reminders] ticket=${row.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return sentCount;
}

async function sendOneReminder(args: {
  sb:          SupabaseClient;
  workspaceId: string;
  ticketId:    string;
  portalBase?: string;
}): Promise<boolean> {
  const { sb, workspaceId, ticketId } = args;
  // Re-pull the ticket row in full now that it's on the hot path. The
  // select shape mirrors sendCsatSurvey above; could be factored later,
  // but the duplication is small enough to leave for now.
  const { data: ticket } = await sb
    .from('tickets')
    .select(`
      id, display_id, subject, csat_token, csat_submitted_at, csat_last_reminded_at,
      customers(first_name, last_name, email),
      workspaces(name, slug)
    `)
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!ticket) return false;
  const t = ticket as any;
  // Belt-and-suspenders re-checks — the scan filter SHOULD already
  // guarantee these, but races with concurrent rating submission +
  // SQL view caches make a direct check cheap insurance.
  if (t.csat_submitted_at)    return false;
  if (t.csat_last_reminded_at) return false;
  if (!t.csat_token)          return false;
  const customer = t.customers || {};
  if (!customer.email) return false;
  const workspaceName = t.workspaces?.name || 'Support';
  const workspaceSlug = t.workspaces?.slug;
  if (!workspaceSlug) return false;

  const workspaceFrom = await getOutboundFrom(sb, workspaceId);
  const fromEmail = workspaceFrom?.fromEmail || env.POSTMARK_OUTBOUND_FROM;
  const fromName  = workspaceFrom?.fromName  || workspaceName;
  if (!fromEmail) return false;

  const portalBase = args.portalBase || env.PORTAL_BASE_URL || 'http://localhost:5173/portal.html';
  const surveyUrl  = `${portalBase}?ws=${encodeURIComponent(workspaceSlug)}&csat=${encodeURIComponent(t.csat_token)}`;
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'there';
  const subject = `Reminder — how did we do? · ${t.display_id}`;
  const textBody = [
    `Hi ${customerName},`,
    '',
    `Just a quick reminder — we'd love your feedback on the support you got for "${t.subject}". It takes about 10 seconds:`,
    '',
    surveyUrl,
    '',
    `Thanks,`,
    workspaceName,
  ].join('\n');

  try {
    await sendEmail({
      to: customer.email, subject, textBody, fromEmail, fromName,
      replyTo: env.POSTMARK_INBOUND_REPLY_ADDRESS || null,
    });
  } catch (err) {
    const detail = err instanceof PostmarkSendError
      ? `code=${err.code} status=${err.httpStatus}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.warn(`[csat-reminders] Postmark send failed for ticket ${ticketId}: ${detail}`);
    return false;
  }

  await sb
    .from('tickets')
    .update({ csat_last_reminded_at: new Date().toISOString() })
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId);
  return true;
}

export function startCsatReminderWorker(sb: SupabaseClient): void {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => {
    processCsatReminders(sb).catch((err) => {
      console.error('[csat-reminders] tick failed:', err);
    });
  }, REMINDER_TICK_MS);
}

export function stopCsatReminderWorker(): void {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
}
