import type { TriageOutput } from './triage.ts';
import { env } from './env.ts';
import { getDb } from './db.ts';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().
// postmark-outbound is external HTTP.
import {
  isPostmarkConfigured,
  PostmarkSendError,
  replySubject,
  sendEmail,
} from './postmark-outbound.ts';
import { getOutboundFrom } from './outbound-from.ts';

// ─── Config ──────────────────────────────────────────────────────────────

export interface WorkspaceAutoReplyConfig {
  min_confidence: number | null;     // null = auto-reply disabled
  categories: string[];              // empty = no auto-reply
  name: string;                      // workspace name, used as sign-off in the reply
}

// ─── Evaluation ──────────────────────────────────────────────────────────

export type AutoReplyDecision =
  | { eligible: true; reason: 'all_gates_passed' }
  | { eligible: false; reason:
      | 'workspace_disabled'
      | 'category_not_allowed'
      | 'confidence_below_threshold' };

/**
 * Pure function — no DB access, easy to unit test. Returns eligibility +
 * a tag describing why so callers can log it.
 */
export function evaluateAutoReply(
  triage: TriageOutput,
  config: WorkspaceAutoReplyConfig,
): AutoReplyDecision {
  if (config.min_confidence === null || config.categories.length === 0) {
    return { eligible: false, reason: 'workspace_disabled' };
  }
  if (!config.categories.includes(triage.category_key)) {
    return { eligible: false, reason: 'category_not_allowed' };
  }
  if (triage.confidence < config.min_confidence) {
    return { eligible: false, reason: 'confidence_below_threshold' };
  }
  return { eligible: true, reason: 'all_gates_passed' };
}

// ─── Posting ─────────────────────────────────────────────────────────────

export interface PostAutoReplyArgs {
  workspaceId: string;
  ticketId: string;
  draftReply: string;
  confidence: number;
  model: string;
  workspaceName: string;
}

export type PostAutoReplyResult =
  | { posted: true; message_id: string; postmark_message_id: string; rfc_message_id: string }
  | { posted: false; reason:
      | 'already_auto_replied'
      | 'postmark_not_configured'
      | 'customer_email_missing'
      | 'send_failed';
      detail?: string };

/**
 * Send the AI draft to the customer via Postmark, then record it as an
 * ai-role ticket_messages row + audit event. Idempotent: if an auto_reply
 * event already exists on this ticket, returns posted=false rather than
 * sending again.
 *
 * Ordering: send first, then record. If the DB writes fail after a
 * successful send, the worst case on retry is one duplicate email (the
 * idempotency check will pass because no event row was written). The
 * alternative — record first, send second — risks a "ghost" reply in the
 * ticket thread that the customer never received, which is worse.
 *
 * Send failures (Postmark not configured, customer has no email, Postmark
 * rejects) return posted=false with a reason; the ai_draft_reply stays on
 * the ticket so a human can review and send manually.
 */
export async function postAutoReply(args: PostAutoReplyArgs): Promise<PostAutoReplyResult> {
  const { workspaceId, ticketId, draftReply, confidence, model, workspaceName } = args;
  const sql = getDb();

  // 1. Idempotency check — has this ticket already been auto-replied?
  const [existing] = await sql`
    select id from events
    where workspace_id = ${workspaceId} and entity_type = 'ticket'
      and entity_id = ${ticketId} and kind = 'auto_reply'
    limit 1
  `;
  if (existing) {
    return { posted: false, reason: 'already_auto_replied' };
  }

  // 2. Bail early if outbound isn't configured. The draft is still on the
  //    ticket; an agent can copy/paste it manually until env is wired up.
  if (!isPostmarkConfigured()) {
    return { posted: false, reason: 'postmark_not_configured' };
  }

  // 3. Load what we need to send: customer email + subject + last customer
  //    message's external_message_id (for In-Reply-To threading).
  const sendContext = await loadSendContext(ticketId, workspaceId);
  if (!sendContext.customerEmail) {
    return { posted: false, reason: 'customer_email_missing' };
  }

  // 4a. Resolve per-workspace From identity. Brand-owned verified domain
  //     wins; fall back to the platform-default env-var sender for
  //     workspaces without a verified domain (e.g. the demo workspace).
  //     If neither resolves, we have nothing to send from — skip.
  const workspaceFrom = await getOutboundFrom(workspaceId);
  const fromEmail = workspaceFrom?.fromEmail || env.POSTMARK_OUTBOUND_FROM;
  const fromName = workspaceFrom?.fromName || workspaceName;
  if (!fromEmail) {
    return { posted: false, reason: 'postmark_not_configured' };
  }

  // 4b. Send via Postmark. On failure, leave the draft and return — don't
  //     create the event row, so a manual re-triage from the UI can retry.
  let postmarkMessageId: string;
  let rfcMessageId: string;
  try {
    const result = await sendEmail({
      to: sendContext.customerEmail,
      subject: replySubject(sendContext.subject),
      textBody: draftReply,
      fromEmail,
      fromName,
      inReplyTo: sendContext.lastCustomerMessageId,
      // Route customer replies back through the inbound webhook so they
      // attach to this ticket rather than landing in the From mailbox.
      // Empty string means use From as Reply-To (Postmark default).
      replyTo: env.POSTMARK_INBOUND_REPLY_ADDRESS || null,
    });
    postmarkMessageId = result.messageId;
    rfcMessageId = result.rfcMessageId;
  } catch (err) {
    const detail = err instanceof PostmarkSendError
      ? `code=${err.code} status=${err.httpStatus}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.error(`[auto-reply] Postmark send failed for ticket ${ticketId}: ${detail}`);
    return { posted: false, reason: 'send_failed', detail };
  }

  // 5. Post the AI message. author_label is the workspace name so the customer
  //    sees a brand-consistent sender (matches the prompt's sign-off rule).
  //    Store the FULL RFC Message-Id (with brackets + domain) — same format
  //    as customer inbound messages — so In-Reply-To matching on a reply
  //    finds this row exactly.
  const [msg] = await sql<{ id: string }[]>`
    insert into ticket_messages (workspace_id, ticket_id, role, author_user_id, author_label, body, external_message_id)
    values (${workspaceId}, ${ticketId}, 'ai', null, ${workspaceName}, ${draftReply}, ${rfcMessageId})
    returning id
  `;
  if (!msg) throw new Error('Auto-reply message insert failed');

  // 6. Audit event — confidence + model + Postmark ID for delivery correlation.
  try {
    await sql`
      insert into events (workspace_id, entity_type, entity_id, kind, author_label, details)
      values (${workspaceId}, 'ticket', ${ticketId}, 'auto_reply', ${workspaceName},
        ${`Auto-reply sent (confidence ${confidence}, model ${model}, postmark_id ${postmarkMessageId})`})
    `;
  } catch (err) {
    console.error('[auto-reply] event log failed:', err instanceof Error ? err.message : err);
    // Don't fail the whole post — the email already went out + message row exists.
  }

  return {
    posted: true,
    message_id: msg.id,
    postmark_message_id: postmarkMessageId,
    rfc_message_id: rfcMessageId,
  };
}

// ─── Send context loader ─────────────────────────────────────────────────

interface SendContext {
  customerEmail: string | null;
  subject: string;
  lastCustomerMessageId: string | null;   // RFC Message-ID for threading
}

async function loadSendContext(
  ticketId: string,
  workspaceId: string,
): Promise<SendContext> {
  const sql = getDb();
  const [ticket] = await sql<{ subject: string; email: string | null }[]>`
    select t.subject, c.email
    from tickets t left join customers c on c.id = t.customer_id
    where t.id = ${ticketId} and t.workspace_id = ${workspaceId}
  `;
  if (!ticket) throw new Error('Ticket lookup for send failed: not found');

  // Most recent customer message with a Message-ID → our In-Reply-To (if any).
  const [lastMsg] = await sql<{ external_message_id: string }[]>`
    select external_message_id from ticket_messages
    where ticket_id = ${ticketId} and workspace_id = ${workspaceId} and role = 'customer'
      and deleted_at is null and external_message_id is not null
    order by created_at desc
    limit 1
  `;

  return {
    customerEmail: ticket.email ?? null,
    subject: ticket.subject,
    lastCustomerMessageId: lastMsg?.external_message_id ?? null,
  };
}
