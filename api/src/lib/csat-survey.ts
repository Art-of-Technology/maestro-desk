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

import { env } from './env.ts';
import { sendEmail, isPostmarkConfigured, PostmarkSendError } from './postmark-outbound.ts';
import { getOutboundFrom } from './outbound-from.ts';
import { getDb } from './db.ts';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().
// Postmark send unchanged.

export type CsatSurveyResult =
  | { sent: true;  token: string }
  | { sent: false; reason: 'already_requested' | 'already_rated' | 'no_email' | 'postmark_not_configured' | 'no_from' | 'no_workspace' | 'send_failed'; detail?: string };

export async function sendCsatSurvey(args: {
  workspaceId: string;
  ticketId:    string;
  portalBase?: string;
}): Promise<CsatSurveyResult> {
  const { workspaceId, ticketId } = args;
  if (!isPostmarkConfigured()) return { sent: false, reason: 'postmark_not_configured' };
  const sql = getDb();

  const [t] = await sql<{
    display_id: string; subject: string; csat_requested_at: string | null; csat_submitted_at: string | null;
    csat_token: string | null; first_name: string | null; last_name: string | null; email: string | null;
    ws_name: string; ws_slug: string;
  }[]>`
    select t.display_id, t.subject, t.csat_requested_at, t.csat_submitted_at, t.csat_token,
           c.first_name, c.last_name, c.email, w.name as ws_name, w.slug as ws_slug
    from tickets t
    left join customers c on c.id = t.customer_id
    join workspaces w on w.id = t.workspace_id
    where t.id = ${ticketId} and t.workspace_id = ${workspaceId} and t.deleted_at is null
  `;
  if (!t) return { sent: false, reason: 'no_workspace' };
  if (t.csat_submitted_at)   return { sent: false, reason: 'already_rated' };
  if (t.csat_requested_at)   return { sent: false, reason: 'already_requested' };
  const customer = { first_name: t.first_name, last_name: t.last_name, email: t.email };
  const customerEmail = customer.email;
  if (!customerEmail) return { sent: false, reason: 'no_email' };
  const workspaceName = t.ws_name || 'Support';
  const workspaceSlug = t.ws_slug;
  if (!workspaceSlug) return { sent: false, reason: 'no_workspace' };

  // Generate the customer-link token first. We commit it to the row
  // before sending so the survey URL is valid the moment the email
  // lands. Reusing an existing token (idempotent on retry) keeps the
  // link stable if the email is sent twice for some reason.
  const token = t.csat_token || generateToken();

  // Outbound identity: brand-owned verified domain if configured,
  // else the platform default. Skipping here on no-from would mean
  // sending from nothing, so bail cleanly.
  const workspaceFrom = await getOutboundFrom(workspaceId);
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
  await sql`
    update tickets set csat_token = ${token}, csat_requested_at = now()
    where id = ${ticketId} and workspace_id = ${workspaceId}
  `;

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

// Default cadence (cumulative days from initial csat_requested_at)
// applied to workspaces that don't override the column. Operators
// edit per-workspace via workspace.csat_reminder_days, validated in
// workspace.ts PATCH.
export const DEFAULT_REMINDER_DAYS = [3, 7, 14] as const;
const REMINDER_TICK_MS = 60 * 60 * 1000;  // every hour
let reminderTimer: ReturnType<typeof setInterval> | null = null;

export async function processCsatReminders(portalBase?: string): Promise<number> {
  if (!isPostmarkConfigured()) return 0;
  const sql = getDb();
  // Per-workspace cadence is variable, so we can't pre-bake the exact gate in
  // SQL. Use generous bounds (≥1 day old, <6 reminders) and run the precise
  // cadence step per-row in code, with the workspace's array joined in.
  const generousCutoff = new Date(Date.now() - 86400000).toISOString();
  let candidates: Array<{ id: string; workspace_id: string; csat_requested_at: string; csat_reminder_count: number; csat_reminder_days: number[] | null }>;
  try {
    candidates = [...await sql`
      select t.id, t.workspace_id, t.csat_requested_at, t.csat_reminder_count, w.csat_reminder_days
      from tickets t join workspaces w on w.id = t.workspace_id
      where t.csat_submitted_at is null and t.csat_reminder_count < 6
        and t.csat_requested_at is not null and t.csat_token is not null and t.deleted_at is null
        and t.csat_requested_at <= ${generousCutoff}
      limit 200
    ` as any];
  } catch (err) {
    console.error('[csat-reminders] scan failed:', err instanceof Error ? err.message : err);
    return 0;
  }
  if (candidates.length === 0) return 0;

  const now = Date.now();
  let sentCount = 0;
  for (const row of candidates) {
    const cadence = row.csat_reminder_days ?? Array.from(DEFAULT_REMINDER_DAYS);
    if (cadence.length === 0) continue;   // empty cadence = reminders disabled
    const nextIndex = row.csat_reminder_count;
    if (nextIndex >= cadence.length) continue;
    const ageDays = (now - new Date(row.csat_requested_at).getTime()) / 86400000;
    if (ageDays < cadence[nextIndex]) continue;
    try {
      const ok = await sendOneReminder({
        workspaceId: row.workspace_id, ticketId: row.id,
        attemptNumber:  nextIndex + 1,
        totalAttempts:  cadence.length,
        portalBase,
      });
      if (ok) sentCount++;
    } catch (err) {
      console.warn(`[csat-reminders] ticket=${row.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return sentCount;
}

async function sendOneReminder(args: {
  workspaceId:   string;
  ticketId:      string;
  attemptNumber: number;
  totalAttempts: number;
  portalBase?:   string;
}): Promise<boolean> {
  const { workspaceId, ticketId, attemptNumber, totalAttempts } = args;
  const sql = getDb();
  // Re-pull the ticket row in full now that it's on the hot path.
  const [t] = await sql<{
    display_id: string; subject: string; csat_token: string | null; csat_submitted_at: string | null;
    csat_reminder_count: number | null; first_name: string | null; last_name: string | null;
    email: string | null; ws_name: string; ws_slug: string;
  }[]>`
    select t.display_id, t.subject, t.csat_token, t.csat_submitted_at, t.csat_reminder_count,
           c.first_name, c.last_name, c.email, w.name as ws_name, w.slug as ws_slug
    from tickets t
    left join customers c on c.id = t.customer_id
    join workspaces w on w.id = t.workspace_id
    where t.id = ${ticketId} and t.workspace_id = ${workspaceId} and t.deleted_at is null
  `;
  if (!t) return false;
  // Validity checks (can we even build/send the email?) run before the claim
  // so we don't burn the attempt on a row we can't deliver. The submitted /
  // already-reminded race guards move into the atomic claim below.
  if (!t.csat_token)                           return false;
  const customer = { first_name: t.first_name, last_name: t.last_name, email: t.email };
  if (!customer.email) return false;
  const workspaceName = t.ws_name || 'Support';
  const workspaceSlug = t.ws_slug;
  if (!workspaceSlug) return false;

  const workspaceFrom = await getOutboundFrom(workspaceId);
  const fromEmail = workspaceFrom?.fromEmail || env.POSTMARK_OUTBOUND_FROM;
  const fromName  = workspaceFrom?.fromName  || workspaceName;
  if (!fromEmail) return false;

  // Atomically CLAIM this reminder attempt before sending. The WHERE gates on
  // the exact prior count + not-submitted, so two concurrent runners can't
  // both send — only one UPDATE matches; the loser gets 0 rows and bails.
  // Claiming BEFORE the send means a crash/send-failure costs at most a missed
  // reminder (the attempt is consumed), never a duplicate email.
  const claimed = await sql`
    update tickets
    set csat_reminder_count = ${attemptNumber}, csat_last_reminded_at = now()
    where id = ${ticketId} and workspace_id = ${workspaceId}
      and csat_submitted_at is null and deleted_at is null
      and coalesce(csat_reminder_count, 0) = ${attemptNumber - 1}
    returning id
  `;
  if (claimed.length === 0) return false;

  const portalBase = args.portalBase || env.PORTAL_BASE_URL || 'http://localhost:5173/portal.html';
  const surveyUrl  = `${portalBase}?ws=${encodeURIComponent(workspaceSlug)}&csat=${encodeURIComponent(t.csat_token)}`;
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'there';
  // Soften the tone progressively. Attempt 1 = light nudge; attempt 2
  // adds "another" so it's clearly the second ask; the final one
  // says "last" so the customer knows we won't keep chasing.
  const lastAttempt = attemptNumber >= totalAttempts;
  const prefix = attemptNumber === 1
    ? 'Just a quick reminder'
    : lastAttempt
      ? 'Last reminder'
      : 'Another quick reminder';
  const subject = lastAttempt
    ? `Last reminder — how did we do? · ${t.display_id}`
    : `Reminder — how did we do? · ${t.display_id}`;
  const textBody = [
    `Hi ${customerName},`,
    '',
    `${prefix} — we'd love your feedback on the support you got for "${t.subject}". It takes about 10 seconds:`,
    '',
    surveyUrl,
    '',
    lastAttempt ? `If you don't have time, no worries — this is the last we'll ask. Thanks either way,` : `Thanks,`,
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

  // The attempt was already claimed (count bumped) above — nothing more to do.
  return true;
}

export function startCsatReminderWorker(): void {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => {
    processCsatReminders().catch((err) => {
      console.error('[csat-reminders] tick failed:', err);
    });
  }, REMINDER_TICK_MS);
}

export function stopCsatReminderWorker(): void {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
}
