// Email mentioned agents when a teammate @s them in an internal
// note. Fire-and-forget after the message row is persisted; the
// POST /messages return shouldn't block on Postmark.
//
// Skipped silently when:
//   - mentions[] is empty (the common case for non-note replies)
//   - Postmark isn't configured for the workspace
//   - the only mentioned user IS the author (self-mention)
//   - a mentioned user has no email on file

import { env } from './env.js';
import { isPostmarkConfigured, PostmarkSendError } from './postmark-outbound.js';
import { sendBrandedEmail } from './send-branded-email.js';
import { composeEmail } from './email-branding.js';
import { getDb } from './db.js';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().
// Postmark send unchanged.

export async function notifyMentionedAgents(args: {
  workspaceId:  string;
  ticketId:     string;
  authorUserId: string | null;
  authorLabel:  string | null;
  mentions:     string[];
  body:         string;
}): Promise<{ sent: number; skipped: number }> {
  const { workspaceId, ticketId, authorUserId, authorLabel, mentions, body } = args;
  if (!mentions || mentions.length === 0)  return { sent: 0, skipped: 0 };
  if (!isPostmarkConfigured())             return { sent: 0, skipped: mentions.length };
  const sql = getDb();

  // Strip self-mentions before the user lookup.
  const targets = mentions.filter((id) => id !== authorUserId);
  if (targets.length === 0) return { sent: 0, skipped: 0 };

  const [usersRows, ticketRows] = await Promise.all([
    sql<{ id: string; name: string | null; email: string | null; mention_email_enabled: boolean | null }[]>`
      select id, name, email, mention_email_enabled from users where id = any(${targets})`,
    sql<{ display_id: string; subject: string; ws_name: string; ws_slug: string }[]>`
      select t.display_id, t.subject, w.name as ws_name, w.slug as ws_slug
      from tickets t join workspaces w on w.id = t.workspace_id
      where t.id = ${ticketId} and t.workspace_id = ${workspaceId}`,
  ]);
  const ticket = ticketRows[0];
  if (!ticket) return { sent: 0, skipped: targets.length };

  const workspaceName = ticket.ws_name || 'Respovia';
  const workspaceSlug = ticket.ws_slug;

  // Build the ticket-detail URL. Agents reach it via the SPA, so the link
  // base is APP_BASE_URL (the agent app's origin) — NOT PORTAL_BASE_URL,
  // which is the customer portal and may live on a different host. The
  // link is best-effort — agents will likely already have the SPA open
  // and can search by display_id either way.
  const agentBase = env.APP_BASE_URL;
  const ticketUrl = `${agentBase}/?ws=${encodeURIComponent(workspaceSlug || '')}#ticket/${encodeURIComponent(ticket.display_id)}`;

  // Truncate the note body — the email is a notification, not a
  // mirror. Agents click through to see the full thread.
  const excerpt = body.length > 400 ? body.slice(0, 400) + '…' : body;
  const author  = authorLabel || 'A teammate';

  let sent = 0;
  let skipped = 0;
  for (const u of usersRows) {
    if (!u.email) { skipped++; continue; }
    // Per-user opt-out. The default-true column means absence of the
    // preference (legacy rows pre-migration) gets the emails.
    if (u.mention_email_enabled === false) { skipped++; continue; }
    const greeting = u.name ? `Hi ${u.name.split(/\s+/)[0]},` : 'Hi,';
    const subject = `${author} mentioned you on ${ticket.display_id}`;
    const textBody = [
      greeting,
      '',
      `${author} mentioned you in an internal note on ticket ${ticket.display_id}: "${ticket.subject}".`,
      '',
      '— Note —',
      excerpt,
      '— End note —',
      '',
      ticketUrl,
      '',
      workspaceName,
    ].join('\n');
    // Brand with the workspace header/footer and the mentioning agent's own
    // signature (authorUserId) — this email comes from a named teammate.
    const composed = await composeEmail({ workspaceId, authorUserId, bodyText: textBody });
    try {
      // Branded From with platform fallback + rejection safety net.
      await sendBrandedEmail({
        workspaceId, fallbackFromName: workspaceName,
        to: u.email, subject, textBody: composed.text, htmlBody: composed.html,
        replyTo: env.POSTMARK_INBOUND_REPLY_ADDRESS || null,
      });
      sent++;
    } catch (err) {
      const detail = err instanceof PostmarkSendError
        ? `code=${err.code} status=${err.httpStatus}: ${err.message}`
        : err instanceof Error ? err.message : String(err);
      console.warn(`[mention-notify] failed for user ${u.id} on ticket ${ticketId}: ${detail}`);
      skipped++;
    }
  }
  return { sent, skipped };
}
