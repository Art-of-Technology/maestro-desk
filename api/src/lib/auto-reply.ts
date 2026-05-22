import type { SupabaseClient } from '@supabase/supabase-js';
import type { TriageOutput } from './triage.ts';
import { env } from './env.ts';
import {
  isPostmarkConfigured,
  PostmarkSendError,
  replySubject,
  sendEmail,
} from './postmark-outbound.ts';

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
  sb: SupabaseClient;
  workspaceId: string;
  ticketId: string;
  draftReply: string;
  confidence: number;
  model: string;
  workspaceName: string;
}

export type PostAutoReplyResult =
  | { posted: true; message_id: string; postmark_message_id: string | null }
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
  const { sb, workspaceId, ticketId, draftReply, confidence, model, workspaceName } = args;

  // 1. Idempotency check — has this ticket already been auto-replied?
  const { data: existing, error: eErr } = await sb
    .from('events')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('entity_type', 'ticket')
    .eq('entity_id', ticketId)
    .eq('kind', 'auto_reply')
    .limit(1)
    .maybeSingle();
  if (eErr) throw new Error(`Auto-reply idempotency check failed: ${eErr.message}`);
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
  const sendContext = await loadSendContext(sb, ticketId, workspaceId);
  if (!sendContext.customerEmail) {
    return { posted: false, reason: 'customer_email_missing' };
  }

  // 4. Send via Postmark. On failure, leave the draft and return — don't
  //    create the event row, so a manual re-triage from the UI can retry.
  let postmarkMessageId: string | null = null;
  try {
    const result = await sendEmail({
      to: sendContext.customerEmail,
      subject: replySubject(sendContext.subject),
      textBody: draftReply,
      fromEmail: env.POSTMARK_OUTBOUND_FROM,
      fromName: workspaceName,
      inReplyTo: sendContext.lastCustomerMessageId,
    });
    postmarkMessageId = result.messageId;
  } catch (err) {
    const detail = err instanceof PostmarkSendError
      ? `code=${err.code} status=${err.httpStatus}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    console.error(`[auto-reply] Postmark send failed for ticket ${ticketId}: ${detail}`);
    return { posted: false, reason: 'send_failed', detail };
  }

  // 5. Post the AI message. author_label is the workspace name so the customer
  //    sees a brand-consistent sender (matches the prompt's sign-off rule).
  //    Store Postmark's returned MessageID so a future inbound reply can be
  //    linked via In-Reply-To matching (deferred — captured for free now).
  const { data: msg, error: mErr } = await sb
    .from('ticket_messages')
    .insert({
      workspace_id: workspaceId,
      ticket_id: ticketId,
      role: 'ai',
      author_user_id: null,
      author_label: workspaceName,
      body: draftReply,
      external_message_id: postmarkMessageId,
    })
    .select('id')
    .single();
  if (mErr) throw new Error(`Auto-reply message insert failed: ${mErr.message}`);

  // 6. Audit event. details captures confidence + model + the Postmark ID so
  //    future review can correlate to Postmark's delivery dashboard.
  const { error: evErr } = await sb.from('events').insert({
    workspace_id: workspaceId,
    entity_type: 'ticket',
    entity_id: ticketId,
    kind: 'auto_reply',
    author_label: workspaceName,
    details: `Auto-reply sent (confidence ${confidence}, model ${model}, postmark_id ${postmarkMessageId ?? 'unknown'})`,
  });
  if (evErr) {
    console.error('[auto-reply] event log failed:', evErr.message);
    // Don't fail the whole post — the email already went out + message row exists.
  }

  return { posted: true, message_id: msg.id, postmark_message_id: postmarkMessageId };
}

// ─── Send context loader ─────────────────────────────────────────────────

interface SendContext {
  customerEmail: string | null;
  subject: string;
  lastCustomerMessageId: string | null;   // RFC Message-ID for threading
}

async function loadSendContext(
  sb: SupabaseClient,
  ticketId: string,
  workspaceId: string,
): Promise<SendContext> {
  // Single ticket + customer join. customers comes back as an array because
  // of the relation; flatten on read.
  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .select('subject, customers(email)')
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .single();
  if (tErr || !ticket) throw new Error(`Ticket lookup for send failed: ${tErr?.message ?? 'not found'}`);

  const customer = (Array.isArray(ticket.customers) ? ticket.customers[0] : ticket.customers) as
    | { email: string | null }
    | null;

  // Most recent customer message — its Message-ID becomes our In-Reply-To.
  // If there isn't one (e.g. ticket created by an agent via UI), we still
  // send, just without threading.
  const { data: lastMsg, error: mErr } = await sb
    .from('ticket_messages')
    .select('external_message_id')
    .eq('ticket_id', ticketId)
    .eq('workspace_id', workspaceId)
    .eq('role', 'customer')
    .is('deleted_at', null)
    .not('external_message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (mErr) throw new Error(`Customer message lookup failed: ${mErr.message}`);

  return {
    customerEmail: customer?.email ?? null,
    subject: ticket.subject,
    lastCustomerMessageId: lastMsg?.external_message_id ?? null,
  };
}
