// Email mentioned agents when a teammate @s them in an internal
// note. Fire-and-forget after the message row is persisted; the
// POST /messages return shouldn't block on Postmark.
//
// Skipped silently when:
//   - mentions[] is empty (the common case for non-note replies)
//   - Postmark isn't configured for the workspace
//   - the only mentioned user IS the author (self-mention)
//   - a mentioned user has no email on file

import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.ts';
import { sendEmail, isPostmarkConfigured, PostmarkSendError } from './postmark-outbound.ts';
import { getOutboundFrom } from './outbound-from.ts';

export async function notifyMentionedAgents(args: {
  sb:           SupabaseClient;
  workspaceId:  string;
  ticketId:     string;
  authorUserId: string | null;
  authorLabel:  string | null;
  mentions:     string[];
  body:         string;
}): Promise<{ sent: number; skipped: number }> {
  const { sb, workspaceId, ticketId, authorUserId, authorLabel, mentions, body } = args;
  if (!mentions || mentions.length === 0)  return { sent: 0, skipped: 0 };
  if (!isPostmarkConfigured())             return { sent: 0, skipped: mentions.length };

  // Strip self-mentions before the user lookup — saves a round-trip
  // when the only mention is the author themselves.
  const targets = mentions.filter((id) => id !== authorUserId);
  if (targets.length === 0) return { sent: 0, skipped: 0 };

  const [usersRes, ticketRes, workspaceFrom] = await Promise.all([
    sb.from('users').select('id, name, email, mention_email_enabled').in('id', targets),
    sb.from('tickets').select('display_id, subject, workspaces(name, slug)').eq('id', ticketId).eq('workspace_id', workspaceId).maybeSingle(),
    getOutboundFrom(sb, workspaceId),
  ]);
  if (!ticketRes.data) return { sent: 0, skipped: targets.length };

  const ticket = ticketRes.data as any;
  const workspaceName = ticket.workspaces?.name || 'Maestro Desk';
  const workspaceSlug = ticket.workspaces?.slug;
  const fromEmail = workspaceFrom?.fromEmail || env.POSTMARK_OUTBOUND_FROM;
  const fromName  = workspaceFrom?.fromName  || workspaceName;
  if (!fromEmail) return { sent: 0, skipped: targets.length };

  // Build the ticket-detail URL. Agents reach it via the SPA, so we
  // point at PORTAL_BASE_URL's origin + an SPA-style hash route if
  // configured; otherwise the localhost dev SPA. The link is best-
  // effort — agents will likely already have the SPA open and can
  // search by display_id either way.
  const agentBase = env.PORTAL_BASE_URL
    ? new URL(env.PORTAL_BASE_URL).origin
    : 'http://localhost:5173';
  const ticketUrl = `${agentBase}/?ws=${encodeURIComponent(workspaceSlug || '')}#ticket/${encodeURIComponent(ticket.display_id)}`;

  // Truncate the note body — the email is a notification, not a
  // mirror. Agents click through to see the full thread.
  const excerpt = body.length > 400 ? body.slice(0, 400) + '…' : body;
  const author  = authorLabel || 'A teammate';

  let sent = 0;
  let skipped = 0;
  for (const u of (usersRes.data || []) as Array<{ id: string; name: string | null; email: string | null; mention_email_enabled: boolean | null }>) {
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
    try {
      await sendEmail({
        to: u.email, subject, textBody, fromEmail, fromName,
        replyTo: env.POSTMARK_INBOUND_REPLY_ADDRESS || null,
      });
      sent++;
    } catch (err) {
      const detail = err instanceof PostmarkSendError
        ? `code=${err.code} status=${err.httpStatus}: ${err.message}`
        : err instanceof Error ? err.message : String(err);
      console.warn(`[mention-notify] failed for ${u.email} on ticket ${ticketId}: ${detail}`);
      skipped++;
    }
  }
  return { sent, skipped };
}
