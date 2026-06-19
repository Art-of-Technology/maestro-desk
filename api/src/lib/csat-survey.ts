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

import { env } from './env.js';
import { sendEmail, isPostmarkConfigured, PostmarkSendError } from './postmark-outbound.js';
import { getOutboundFrom } from './outbound-from.js';
import { getDb } from './db.js';

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
