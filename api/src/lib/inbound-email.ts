import type { SupabaseClient } from '@supabase/supabase-js';
import {
  extractInReplyTo,
  extractMessageId,
  parseFrom,
  parseTo,
  pickBody,
  type PostmarkInbound,
} from './postmark.ts';
import { triageTicket } from './triage.ts';
import { BudgetExceededError } from './budget.ts';
import { scoreMessageSentiment } from './sentiment.ts';

// Fire-and-forget wrapper around scoreMessageSentiment used by the
// inbound-email and reply paths. We never want sentiment to break the
// webhook response — log + swallow on any throw so Postmark still
// gets its 200 and the message row is already persisted.
function scoreInboundMessage(args: { sb: SupabaseClient; workspaceId: string; ticketId: string; messageId: string; body: string }): void {
  void scoreMessageSentiment(args).catch((err) => {
    console.warn('[sentiment] inbound score failed:', err instanceof Error ? err.message : err);
  });
}

// ─── Display ID generation ───────────────────────────────────────────────
//
// Placeholder — random 6-digit numbers. Same approach as POST /tickets.
// Replace with a per-workspace sequence (or trigger) before this is
// exposed to real users.

function nextTicketDisplayId(): string {
  return `TK-${Math.floor(Math.random() * 900000 + 100000)}`;
}

function nextCustomerDisplayId(): string {
  return `M${String(Math.floor(Math.random() * 9000 + 1000))}`;
}

// ─── Inbox message helper ────────────────────────────────────────────────
//
// Resolves the workspace's channel for this inbound (best match by To:
// address, else first active email channel), then writes an
// inbox_messages row. Skipped silently when no channel exists (e.g.
// unrouted bucket, freshly provisioned brand with no channels seeded) —
// inbox_messages.channel_id is NOT NULL so we can't write a placeholder.
// Errors are logged but never thrown: the inbox row is an audit trail,
// not load-bearing for the customer-facing ticket creation.
async function recordInboundInInbox(args: {
  sb: SupabaseClient;
  workspaceId: string;
  payload: PostmarkInbound;
  ticketId: string;
  toEmail: string | null;
}): Promise<void> {
  const { sb, workspaceId, payload, ticketId, toEmail } = args;

  const { data: channels, error: chErr } = await sb
    .from('channels')
    .select('id, address')
    .eq('workspace_id', workspaceId)
    .eq('type', 'email')
    .eq('status', 'active');
  if (chErr) {
    console.warn('[inbound-email] channel lookup failed:', chErr.message);
    return;
  }
  if (!channels || channels.length === 0) return;

  const matched = toEmail
    ? channels.find((c) => (c.address || '').toLowerCase() === toEmail.toLowerCase())
    : null;
  const channelId = matched?.id ?? channels[0].id;

  const { email, name } = parseFrom(payload);
  const body = pickBody(payload);

  const { error: insErr } = await sb.from('inbox_messages').insert({
    workspace_id:        workspaceId,
    channel_id:          channelId,
    external_id:         extractMessageId(payload),
    from_name:           name || null,
    from_email:          email,
    subject:             payload.Subject || null,
    body,
    received_at:         new Date().toISOString(),
    status:              'converted',
    converted_ticket_id: ticketId,
  });
  if (insErr) {
    // Unique violation on (channel_id, external_id) is expected on Postmark
    // retries — silent skip. Anything else, log it.
    if (insErr.code !== '23505') {
      console.warn('[inbound-email] inbox_messages insert failed:', insErr.message);
    }
  }
}

// ─── Workspace resolution ────────────────────────────────────────────────
//
// Maps an inbound email's To: domain to the destination workspace.
//
// Lookup is against workspace_email_domains (citext column — case folding
// is handled by the database). On no-match, mail falls through to the
// system "unrouted" workspace (is_unrouted_bucket = true, seeded by
// 20260522150000_workspace_branding.sql) so a customer email never
// silently drops. The platform admin reviews unrouted mail in the god UI
// and either creates the missing brand or replies via the bucket directly.

export interface WorkspaceResolution {
  workspaceId: string;
  routed: boolean;             // false → fell back to the unrouted bucket
  matchedDomain: string | null;
}

export async function resolveInboundWorkspace(args: {
  sb: SupabaseClient;
  toDomain: string | null;
}): Promise<WorkspaceResolution> {
  const { sb, toDomain } = args;

  if (toDomain) {
    const { data: match, error } = await sb
      .from('workspace_email_domains')
      .select('workspace_id, domain')
      .eq('domain', toDomain)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(`Domain lookup failed: ${error.message}`);
    if (match) {
      return { workspaceId: match.workspace_id, routed: true, matchedDomain: match.domain };
    }
  }

  const { data: bucket, error: bErr } = await sb
    .from('workspaces')
    .select('id')
    .eq('is_unrouted_bucket', true)
    .single();
  if (bErr) throw new Error(`Unrouted bucket lookup failed: ${bErr.message}`);
  return { workspaceId: bucket.id, routed: false, matchedDomain: null };
}

// ─── Entry point ─────────────────────────────────────────────────────────

export interface InboundResult {
  ticket_id: string;
  ticket_display_id: string;
  customer_id: string;
  is_new_customer: boolean;
  auto_triage_queued: boolean;
  // true when this payload's RFC Message-ID matched an existing
  // customer message — Postmark retry, no new ticket created.
  deduped: boolean;
  // true when In-Reply-To matched a prior message and this email was
  // attached to that existing ticket instead of creating a new one.
  threaded: boolean;
}

/**
 * Convert an inbound email into a ticket. Steps:
 *   0. Dedup check: if a customer message with this RFC Message-ID already
 *      exists for the workspace, return its ticket without creating anything.
 *   1. Match the sender against customers by email; create a stub if missing.
 *   2. Create a ticket with status=open, priority=normal (triage may change these).
 *   3. Create the first ticket_messages row from the email body.
 *   4. Fire-and-forget auto-triage. The webhook returns immediately so Postmark
 *      doesn't retry — triage runs in the background and updates the ticket
 *      when done.
 *
 * Called by the Postmark webhook handler. Assumes the request has already
 * been authenticated (via Basic Auth in the webhook URL).
 */
export async function processInboundEmail(args: {
  sb: SupabaseClient;
  workspaceId: string;
  payload: PostmarkInbound;
}): Promise<InboundResult> {
  const { sb, workspaceId, payload } = args;
  const { email, name } = parseFrom(payload);
  const body = pickBody(payload);
  const subject = payload.Subject?.trim() || '(no subject)';
  const externalMessageId = extractMessageId(payload);
  const inReplyTo = extractInReplyTo(payload);

  // 0a. Thread-attach — if In-Reply-To references a Message-Id we've seen
  //     before (our own outbound or a prior customer message), attach this
  //     email as a new customer message on the existing ticket instead of
  //     creating a new one. Match against any role (customer + ai), since
  //     replies to our auto-replies target our ai ticket_messages.
  if (inReplyTo) {
    const { data: parent, error: pErr } = await sb
      .from('ticket_messages')
      .select('ticket_id, tickets!inner(id, display_id, customer_id, deleted_at)')
      .eq('workspace_id', workspaceId)
      .eq('external_message_id', inReplyTo)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (pErr) throw new Error(`In-Reply-To lookup failed: ${pErr.message}`);
    if (parent) {
      const t = (Array.isArray(parent.tickets) ? parent.tickets[0] : parent.tickets) as
        | { id: string; display_id: string; customer_id: string; deleted_at: string | null }
        | null;
      // Skip thread-attach if the parent ticket has been soft-deleted —
      // fall through to normal create flow so the reply still surfaces.
      if (t && !t.deleted_at) {
        return await attachReplyToTicket({
          sb, workspaceId, ticketId: t.id, ticketDisplayId: t.display_id,
          customerId: t.customer_id, body, name, email,
          externalMessageId, payload,
        });
      }
    }
  }

  // 0b. Dedup check — Postmark retries deliver the same payload multiple
  //    times. Match by RFC Message-ID; if we already wrote a customer message
  //    with this ID, return the existing ticket instead of creating a
  //    duplicate. Skipped when Message-ID is missing (some senders omit it)
  //    — those payloads can't be deduped and will produce a duplicate ticket
  //    on retry. The partial unique index in 20260522130000 is defense-in-
  //    depth against the concurrent-retry race; the application check below
  //    avoids creating orphan tickets on the way to a 23505.
  if (externalMessageId) {
    const { data: dup, error: dErr } = await sb
      .from('ticket_messages')
      .select('ticket_id, tickets!inner(display_id, customer_id)')
      .eq('workspace_id', workspaceId)
      .eq('role', 'customer')
      .eq('external_message_id', externalMessageId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (dErr) throw new Error(`Inbound dedup lookup failed: ${dErr.message}`);
    if (dup) {
      const t = (Array.isArray(dup.tickets) ? dup.tickets[0] : dup.tickets) as
        | { display_id: string; customer_id: string }
        | null;
      return {
        ticket_id: dup.ticket_id,
        ticket_display_id: t?.display_id ?? '',
        customer_id: t?.customer_id ?? '',
        is_new_customer: false,
        auto_triage_queued: false,
        deduped: true,
        threaded: false,
      };
    }
  }

  // 1. Match-or-create the customer.
  let customerId: string;
  let isNewCustomer = false;
  const { data: existingCustomer, error: cErr } = await sb
    .from('customers')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('email', email)
    .is('deleted_at', null)
    .maybeSingle();
  if (cErr) throw new Error(`Customer lookup failed: ${cErr.message}`);

  if (existingCustomer) {
    customerId = existingCustomer.id;
  } else {
    // Stub customer — name parsed from From header if present, no other PII.
    // Agents can fill in mobile/brand/VIP-tier later via the UI.
    //
    // Race window: two webhook retries for the same NEW sender both miss the
    // lookup above and try to insert. The (workspace_id, email) unique
    // constraint guarantees one wins; the loser hits PG 23505. On that
    // specific error, re-query for the row the winner just created and use
    // that customer_id instead of failing the whole webhook (Postmark would
    // otherwise retry up to 10 times). Any other DB error still bubbles.
    const [firstName, ...rest] = (name ?? email.split('@')[0]).split(/\s+/);
    const lastName = rest.join(' ') || null;
    const insert = await sb
      .from('customers')
      .insert({
        workspace_id: workspaceId,
        display_id: nextCustomerDisplayId(),
        first_name: firstName,
        last_name: lastName,
        email,
      })
      .select('id')
      .single();
    if (insert.error) {
      if (insert.error.code === '23505') {
        const winner = await sb
          .from('customers')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('email', email)
          .is('deleted_at', null)
          .maybeSingle();
        if (winner.error || !winner.data) {
          throw new Error(
            `Customer race recovery failed: ${winner.error?.message ?? 'row not visible after unique violation'}`,
          );
        }
        customerId = winner.data.id;
        // isNewCustomer stays false — the other request created it.
      } else {
        throw new Error(`Customer create failed: ${insert.error.message}`);
      }
    } else {
      customerId = insert.data.id;
      isNewCustomer = true;
    }
  }

  // 2. Create the ticket. Status/priority/category are best-guess defaults;
  //    auto-triage may overwrite them.
  const { data: newTicket, error: tErr } = await sb
    .from('tickets')
    .insert({
      workspace_id: workspaceId,
      display_id: nextTicketDisplayId(),
      subject,
      customer_id: customerId,
      status_key: 'open',
      priority_key: 'normal',
      sla_state: 'ok',
    })
    .select('id, display_id')
    .single();
  if (tErr) throw new Error(`Ticket create failed: ${tErr.message}`);

  // 3. First message from the email body. The RFC Message-ID extracted at
  //    the top is stored so we can thread our reply via In-Reply-To when
  //    auto-reply fires.
  const authorLabel = name?.trim() || email;
  const { data: newMessage, error: mErr } = await sb.from('ticket_messages').insert({
    workspace_id: workspaceId,
    ticket_id: newTicket.id,
    role: 'customer',
    author_label: authorLabel,
    body,
    external_message_id: externalMessageId,
  })
    .select('id')
    .single();
  if (mErr) throw new Error(`Message create failed: ${mErr.message}`);
  void scoreInboundMessage({ sb, workspaceId, ticketId: newTicket.id, messageId: newMessage.id, body });

  // 3b. Audit row in the inbox view. Failures are logged but don't fail
  //     the webhook — the customer-facing ticket has already been created.
  const to = parseTo(payload);
  await recordInboundInInbox({ sb, workspaceId, payload, ticketId: newTicket.id, toEmail: to?.email ?? null });

  // 4. Fire-and-forget auto-triage. We swallow errors here — they're already
  //    logged in ai_usage_log + console — because the webhook MUST return
  //    fast or Postmark will retry. The agent can manually re-trigger
  //    triage via POST /api/v1/tickets/:id/triage if the auto attempt failed.
  let autoTriageQueued = false;
  try {
    // We deliberately don't await this. If the workspace is out of budget
    // (BudgetExceededError), we just log and move on — the ticket still
    // gets created.
    void triageTicket({
      sb,
      ticketId: newTicket.id,
      workspaceId,
      userId: null,   // system-triggered, no user
    }).catch((err) => {
      if (err instanceof BudgetExceededError) {
        console.log(`[inbound-email] auto-triage skipped — workspace ${workspaceId} out of budget`);
      } else {
        console.error('[inbound-email] auto-triage failed:', err);
      }
    });
    autoTriageQueued = true;
  } catch (err) {
    console.error('[inbound-email] failed to queue auto-triage:', err);
  }

  return {
    ticket_id: newTicket.id,
    ticket_display_id: newTicket.display_id,
    customer_id: customerId,
    is_new_customer: isNewCustomer,
    auto_triage_queued: autoTriageQueued,
    deduped: false,
    threaded: false,
  };
}

// ─── Thread-attach helper ────────────────────────────────────────────────

/**
 * Append a new customer message to an existing ticket (matched by
 * In-Reply-To). Doesn't touch the ticket's customer_id — even if the reply
 * comes from a different address (e.g. a Cc'd colleague), the ticket
 * keeps its original customer for continuity. Fires triage again so the
 * AI draft refreshes with the new context.
 */
async function attachReplyToTicket(args: {
  sb: SupabaseClient;
  workspaceId: string;
  ticketId: string;
  ticketDisplayId: string;
  customerId: string;
  body: string;
  name: string | null;
  email: string;
  externalMessageId: string | null;
  payload: PostmarkInbound;
}): Promise<InboundResult> {
  const { sb, workspaceId, ticketId, ticketDisplayId, customerId, body, name, email, externalMessageId, payload } = args;

  const authorLabel = name?.trim() || email;
  const { data: replyMessage, error: mErr } = await sb.from('ticket_messages').insert({
    workspace_id: workspaceId,
    ticket_id: ticketId,
    role: 'customer',
    author_label: authorLabel,
    body,
    external_message_id: externalMessageId,
  })
    .select('id')
    .single();
  if (mErr) throw new Error(`Reply attach failed: ${mErr.message}`);
  void scoreInboundMessage({ sb, workspaceId, ticketId, messageId: replyMessage.id, body });

  // Audit the threaded reply in the inbox view too, so the agent can see
  // the email arrived even if they don't immediately notice the ticket
  // updated. Same fire-and-forget treatment as the new-ticket path.
  const to = parseTo(payload);
  await recordInboundInInbox({ sb, workspaceId, payload, ticketId, toEmail: to?.email ?? null });

  // Fire-and-forget retriage so the AI draft refreshes with the new turn.
  // Errors swallowed (same rationale as the create path) so Postmark gets 200.
  let autoTriageQueued = false;
  try {
    void triageTicket({ sb, ticketId, workspaceId, userId: null }).catch((err) => {
      if (err instanceof BudgetExceededError) {
        console.log(`[inbound-email] retriage skipped — workspace ${workspaceId} out of budget`);
      } else {
        console.error('[inbound-email] retriage failed:', err);
      }
    });
    autoTriageQueued = true;
  } catch (err) {
    console.error('[inbound-email] failed to queue retriage:', err);
  }

  return {
    ticket_id: ticketId,
    ticket_display_id: ticketDisplayId,
    customer_id: customerId,
    is_new_customer: false,
    auto_triage_queued: autoTriageQueued,
    deduped: false,
    threaded: true,
  };
}
