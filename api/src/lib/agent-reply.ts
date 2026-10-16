import { safeError } from './diagnostics.js';
import { sentEmailContent } from './sent-email.js';
import { env } from './env.js';
// Email an agent's public reply to the customer. Called from
// POST /tickets/:id/messages when an agent posts a `role:'agent'` reply (not
// an internal note). Turns the portal-only reply into a real two-way email
// conversation: the reply is branded (header/footer + the sending agent's
// signature), sent via Postmark, and its RFC Message-Id is stamped onto the
// ticket_messages row so the customer's reply threads straight back to this
// ticket (lib/inbound-email matches In-Reply-To against external_message_id).
//
// The message row is inserted by the caller BEFORE this runs and persists
// regardless of the email outcome — a send failure never loses the reply, it
// just reports back so the UI can show "saved, not emailed".

import {
  isPostmarkConfigured,
  PostmarkSendError,
  generateRfcMessageId,
  replySubject,
} from './postmark-outbound.js';
import { sendBrandedEmail } from './send-branded-email.js';
import { availableTicketPrivacy } from './ticket-privacy.js';
import { composeEmail, type ComposedEmail } from './email-branding.js';
import { getDb } from './db.js';
import { EmailRecipients, ticketReplyRecipients, type RecipientInput } from './email-recipients.js';
import { resolveTicketReplyTo } from './ticket-reply-to.js';
import { HTTPException } from 'hono/http-exception';
import { listAttachmentsForMessage, loadOutboundFiles, type OutboundFile } from './message-attachments.js';

export type AgentReplyDelivery =
  | { emailed: true; reason: 'sent'; postmark_message_id: string; fallback_from?: string }
  | { emailed: false; reason:
      | 'postmark_not_configured'   // outbound not wired for this deployment
      | 'no_customer_email'         // portal-only customer / no address on file
      | 'email_suppressed'          // address hard-bounced or was marked spam
      | 'no_from'                   // no sender identity could be resolved
      | 'sending_inbox_unavailable'
      | 'delivery_unconfirmed'
      | 'already_sent'
      | 'send_failed';              // Postmark refused the send
      detail?: string };

export async function sendAgentReplyEmail(args: {
  recipients?: RecipientInput;
  workspaceId:  string;
  ticketId:     string;
  messageId:    string;   // the just-inserted agent ticket_messages row
  authorUserId: string;
  body:         string;
  composed?: ComposedEmail;
  // Sanitised HTML body of a rich-text reply (lib/email-html.ts), with inline
  // images referenced as cid:<attachment id>.
  bodyHtml?:    string | null;
  // Attachments already bound to this message (lib/message-attachments.ts).
  // Inline ones carry a ContentID matching the cid: tokens in bodyHtml.
  attachments?: OutboundFile[];
}): Promise<AgentReplyDelivery> {
  const { workspaceId, ticketId, messageId, authorUserId, body } = args;
  const sql = getDb();
  const privacy = await availableTicketPrivacy(workspaceId, [ticketId]);
  if (!privacy) return { emailed: false, reason: 'send_failed', detail: 'This ticket is no longer available.' };

  // Claim the existing row before loading content; initial sends and retries share this guard.
  const [claimed] = await sql`update ticket_messages
    set email_metadata = coalesce(email_metadata, '{}'::jsonb) || '{"delivery_state":"preparing"}'::jsonb
    where id=${messageId} and ticket_id=${ticketId} and workspace_id=${workspaceId}
      and role='agent' and deleted_at is null and body<>'[erased]' and external_message_id is null
      and cardinality(forwarded_from_ticket_ids)=0 and merged_from_id is null
      and coalesce(email_metadata->>'status','saved')='saved'
      and coalesce(email_metadata->>'delivery_state','failed')='failed'
    returning sent_email, email_metadata`;
  if (!claimed) return { emailed: false, reason: 'already_sent' };
  let attempted = false, state = 'failed';
  try {
    const savedRecipients = claimed.email_metadata?.retry_recipients;
    if (savedRecipients || args.recipients) {
      const parsed = EmailRecipients.safeParse(savedRecipients || args.recipients);
      if (!parsed.success) throw new HTTPException(400, { message: 'The saved email recipients are invalid. Check the ticket before sending again.' });
      args.recipients = parsed.data;
    }
    if (!savedRecipients && args.recipients) {
      await sql`update ticket_messages set email_metadata=email_metadata || ${sql.json({retry_recipients: args.recipients})}
        where id=${messageId} and workspace_id=${workspaceId} and deleted_at is null`;
    }

    const [ctx] = await sql<{
      subject: string;
      ws_name: string;
    }[]>`
      select t.subject, w.name as ws_name
      from tickets t
      join workspaces w on w.id = t.workspace_id
      where t.id = ${ticketId} and t.workspace_id = ${workspaceId} and t.deleted_at is null
    `;
    const recipient = ctx ? await ticketReplyRecipients(workspaceId, ticketId, args.recipients) : null;
    if (!ctx || !recipient?.can_send) return { emailed: false, reason: 'no_customer_email' };
    const sendingChannelId = args.recipients ? args.recipients.sending_channel_id : recipient.default_sending_channel_id;
    const selectedInbox = recipient.sending_inboxes.find(inbox => inbox.id === sendingChannelId);
    const retryRecipients = { source_message_id: recipient.source_message_id, to: recipient.to,
      cc: args.recipients ? recipient.cc : [], mode: args.recipients?.mode || 'reply',
      sending_channel_id: sendingChannelId, sending_address: selectedInbox?.address || null };
    await sql`update ticket_messages set email_metadata=coalesce(email_metadata,'{}'::jsonb) || ${sql.json({ from: selectedInbox?.address || recipient.default_from, to: recipient.to, cc: retryRecipients.cc, status: 'saved', retry_recipients: retryRecipients })}
      where id=${messageId} and workspace_id=${workspaceId}`;
    if (!isPostmarkConfigured()) return { emailed: false, reason: 'postmark_not_configured' };
    // Don't email addresses that hard-bounced or were marked as spam — sending
    // again hurts sender reputation. (Soft bounces are transient → allowed.)
    if (recipient.suppressed) {
      return { emailed: false, reason: 'email_suppressed' };
    }

    // Most recent customer message with a Message-Id → our In-Reply-To, so the
    // customer's mail client threads our reply under their original.
    const [lastMsg] = await sql<{ external_message_id: string }[]>`
      select external_message_id from ticket_messages
      where ticket_id = ${ticketId} and workspace_id = ${workspaceId} and role = 'customer'
        and deleted_at is null and external_message_id is not null
      order by created_at desc
      limit 1
    `;

    // Header/footer + the sending agent's signature (authorUserId).
    const saved = claimed.sent_email;
    const composed = saved ? { text: saved.text, html: saved.html, logoUrl: saved.logo_url } : args.composed ?? await composeEmail({ workspaceId, authorUserId, bodyText: body, bodyHtml: args.bodyHtml ?? null });
    const subject = saved?.subject || replySubject(ctx.subject);
    await sql`update ticket_messages set sent_email=${sql.json(sentEmailContent(composed, subject))}
      where id=${messageId} and workspace_id=${workspaceId} and deleted_at is null`;
    const files = args.attachments ?? await loadOutboundFiles(await listAttachmentsForMessage(workspaceId, messageId));
    const replyTo = await resolveTicketReplyTo(workspaceId, ticketId);

    const attemptId = crypto.randomUUID();
    const rfcMessageId = generateRfcMessageId(env.POSTMARK_OUTBOUND_FROM);
    await sql`update ticket_messages set email_metadata=email_metadata || ${sql.json({
      delivery_state: 'sending', send_attempt_id: attemptId, pending_message_id: rfcMessageId,
      send_attempt_at: new Date().toISOString(),
    })}
      where id=${messageId} and workspace_id=${workspaceId} and deleted_at is null`;
    attempted = true;
    // Branded From (verified domain) with platform fallback + rejection
    // safety net — see send-branded-email.ts.
    const result = await sendBrandedEmail({
      metadata: { workspace_id: workspaceId, message_id: messageId, send_attempt_id: attemptId },
      rfcMessageId,
      privacy,
      workspaceId,
      sendingChannelId,
      expectedSendingAddress: args.recipients ? args.recipients.sending_address : selectedInbox?.address,
      fallbackFromName: ctx.ws_name || 'Support',
      to: recipient.to.join(','),
      cc: args.recipients ? recipient.cc.join(',') : undefined,
      subject,
      textBody: composed.text,
      htmlBody: composed.html,
      inReplyTo: args.recipients ? recipient.in_reply_to : recipient.in_reply_to || lastMsg?.external_message_id || null,
      replyTo,
      attachments: files.map((f) => ({
        Name: f.filename,
        Content: f.base64,
        ContentType: f.mime,
        ContentID: f.contentId,
      })),
    });
    // Stamp the RFC Message-Id (with brackets + domain) onto this reply so a
    // customer reply's In-Reply-To resolves to exactly this row.
    await sql`
      update ticket_messages set external_message_id = ${result.rfcMessageId},
        sent_email = ${sql.json(sentEmailContent(composed, subject))},
        email_metadata = (email_metadata - 'retry_recipients') || ${sql.json({ from: result.fromEmail, to: recipient.to, cc: args.recipients ? recipient.cc : [],
          status: 'sent', delivery_state: 'sent', sent_at: result.submittedAt, postmark_message_id: result.messageId,
          ...(sendingChannelId ? { sending_channel_id: sendingChannelId,
            reply_to: selectedInbox?.address,
            used_fallback_from: result.usedFallbackFrom } : {}) })}
      where id = ${messageId} and workspace_id = ${workspaceId}
    `;
    state = 'sent';
    return { emailed: true, reason: 'sent', postmark_message_id: result.messageId,
      ...(result.usedFallbackFrom ? { fallback_from: result.fromEmail } : {}) };
  } catch (err) {
    if (!attempted) throw err;
    const [receipt] = await sql`select email_metadata from ticket_messages
      where id=${messageId} and workspace_id=${workspaceId} and deleted_at is null`;
    if (receipt?.email_metadata?.status === 'sent') {
      state = 'sent';
      return { emailed: true, reason: 'sent', postmark_message_id: receipt.email_metadata.postmark_message_id };
    }
    // Only a definite refusal is safe to retry. Timeouts, 5xx and failed receipts may have delivered.
    const refused = err instanceof PostmarkSendError &&
      ((err.httpStatus >= 400 && err.httpStatus < 500) || (err.httpStatus >= 200 && err.httpStatus < 300 && err.code > 0));
    const unavailable = err instanceof HTTPException;
    state = !refused && !unavailable ? 'unknown' : 'failed';
    if (err instanceof HTTPException && err.status === 409) return { emailed: false, reason: 'sending_inbox_unavailable' };
    const detail = err instanceof PostmarkSendError
      ? `code=${err.code} status=${err.httpStatus}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.warn('[agent-reply] Postmark send failed:', safeError(err));
    return { emailed: false, reason: state === 'unknown' ? 'delivery_unconfirmed' : 'send_failed', detail };
  } finally {
    await sql`update ticket_messages set email_metadata=coalesce(email_metadata,'{}'::jsonb) || ${sql.json({delivery_state: state})}
      where id=${messageId} and workspace_id=${workspaceId} and deleted_at is null
        and email_metadata->>'delivery_state' in ('preparing','sending')`;
  }
}
