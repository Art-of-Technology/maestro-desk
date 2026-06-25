import { getDb } from './db.js';
import { nextDisplayId } from './display-id.js';
import {
  extractInReplyTo,
  extractMessageId,
  parseFrom,
  parseTo,
  pickBody,
  type PostmarkInbound,
} from './postmark.js';
import { triageTicket } from './triage.js';
import { BudgetExceededError } from './budget.js';
import { scoreMessageSentiment } from './sentiment.js';
import { publishTicketChanged } from './pubby.js';
import { isUserActive } from './activity.js';
import { isPushConfigured, sendPushToUser } from './push.js';

// Fire-and-forget wrapper around scoreMessageSentiment used by the
// inbound-email and reply paths. We never want sentiment to break the
// webhook response — log + swallow on any throw so Postmark still
// gets its 200 and the message row is already persisted.
function scoreInboundMessage(args: { workspaceId: string; ticketId: string; messageId: string; body: string }): void {
  void scoreMessageSentiment(args).catch((err) => {
    console.warn('[sentiment] inbound score failed:', err instanceof Error ? err.message : err);
  });
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
  workspaceId: string;
  payload: PostmarkInbound;
  ticketId: string;
  toEmail: string | null;
}): Promise<void> {
  const { workspaceId, payload, ticketId, toEmail } = args;
  const sql = getDb();

  const channels = await sql<{ id: string; address: string | null }[]>`
    select id, address from channels
    where workspace_id = ${workspaceId} and type = 'email' and status = 'active'
  `;
  if (channels.length === 0) return;

  const matched = toEmail
    ? channels.find((c) => (c.address || '').toLowerCase() === toEmail.toLowerCase())
    : null;
  const channelId = matched?.id ?? channels[0].id;

  const { email, name } = parseFrom(payload);
  const body = pickBody(payload);

  try {
    await sql`
      insert into inbox_messages
        (workspace_id, channel_id, external_id, from_name, from_email, subject, body, received_at, status, converted_ticket_id)
      values
        (${workspaceId}, ${channelId}, ${extractMessageId(payload)}, ${name || null}, ${email},
         ${payload.Subject || null}, ${body}, now(), 'converted', ${ticketId})
    `;
  } catch (err) {
    // Unique violation on (channel_id, external_id) is expected on Postmark
    // retries — silent skip. Anything else, log it.
    if ((err as any)?.code !== '23505') {
      console.warn('[inbound-email] inbox_messages insert failed:', err instanceof Error ? err.message : err);
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
  toDomain: string | null;
}): Promise<WorkspaceResolution> {
  const { toDomain } = args;
  const sql = getDb();

  if (toDomain) {
    const [match] = await sql<{ workspace_id: string; domain: string }[]>`
      select workspace_id, domain from workspace_email_domains
      where domain = ${toDomain} and deleted_at is null
    `;
    if (match) {
      return { workspaceId: match.workspace_id, routed: true, matchedDomain: match.domain };
    }
  }

  const [bucket] = await sql<{ id: string }[]>`select id from workspaces where is_unrouted_bucket = true`;
  if (!bucket) throw new Error('Unrouted bucket lookup failed: not found');
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
  workspaceId: string;
  payload: PostmarkInbound;
}): Promise<InboundResult> {
  const { workspaceId, payload } = args;
  const sql = getDb();
  const { email, name } = parseFrom(payload);
  const body = pickBody(payload);
  const subject = payload.Subject?.trim() || '(no subject)';
  const externalMessageId = extractMessageId(payload);
  const inReplyTo = extractInReplyTo(payload);

  // The thread-attach + dedup lookups below are intentionally
  // WORKSPACE-AGNOSTIC. The webhook resolves a destination workspace from the
  // To: domain, but replies routed through a shared inbound address (e.g.
  // Postmark's `…@inbound.postmarkapp.com`, used when a brand has no verified
  // sending domain) carry no brand in the recipient — domain resolution then
  // falls back to the unrouted bucket. An RFC Message-ID is globally unique,
  // so matching on it directly attaches the reply to the original ticket in
  // its OWN workspace regardless of how the recipient resolved. Both lookups
  // are backed by the ts_msg_external_id index (20260625120000).

  // 0a. Dedup — Postmark retries redeliver the same payload. If we've already
  //     stored a customer message with this incoming RFC Message-ID, return
  //     that ticket instead of creating/attaching a duplicate. Done BEFORE
  //     thread-attach so a retried reply isn't appended to its parent twice.
  //     Skipped when the sender omits Message-ID (can't be deduped).
  if (externalMessageId) {
    const [dup] = await sql<{ ticket_id: string; display_id: string; customer_id: string }[]>`
      select tm.ticket_id, t.display_id, t.customer_id
      from ticket_messages tm
      join tickets t on t.id = tm.ticket_id
      where tm.role = 'customer'
        and tm.external_message_id = ${externalMessageId} and tm.deleted_at is null
      limit 1
    `;
    if (dup) {
      return {
        ticket_id: dup.ticket_id,
        ticket_display_id: dup.display_id ?? '',
        customer_id: dup.customer_id ?? '',
        is_new_customer: false,
        auto_triage_queued: false,
        deduped: true,
        threaded: false,
      };
    }
  }

  // 0b. Thread-attach — if In-Reply-To references a Message-ID we sent (our
  //     outbound agent reply / auto-reply) or a prior customer message, attach
  //     this email onto THAT ticket — in its own workspace — instead of
  //     creating a new one. Match against any role; skip a soft-deleted parent
  //     ticket so the reply still surfaces via the normal create flow.
  if (inReplyTo) {
    const [t] = await sql<{ id: string; workspace_id: string; display_id: string; customer_id: string }[]>`
      select t.id, t.workspace_id, t.display_id, t.customer_id
      from ticket_messages tm
      join tickets t on t.id = tm.ticket_id
      where tm.external_message_id = ${inReplyTo}
        and tm.deleted_at is null and t.deleted_at is null
      order by tm.created_at desc
      limit 1
    `;
    if (t) {
      return await attachReplyToTicket({
        workspaceId: t.workspace_id, ticketId: t.id, ticketDisplayId: t.display_id,
        customerId: t.customer_id, body, name, email,
        externalMessageId, payload,
      });
    }
  }

  // 1. Match-or-create the customer.
  let customerId: string;
  let isNewCustomer = false;
  const [existingCustomer] = await sql<{ id: string }[]>`
    select id from customers
    where workspace_id = ${workspaceId} and email = ${email} and deleted_at is null
  `;

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
    try {
      const custDisplayId = await nextDisplayId(sql, workspaceId, 'customer');
      const [created] = await sql<{ id: string }[]>`
        insert into customers (workspace_id, display_id, first_name, last_name, email)
        values (${workspaceId}, ${custDisplayId}, ${firstName}, ${lastName}, ${email})
        returning id
      `;
      customerId = created.id;
      isNewCustomer = true;
    } catch (err) {
      // (workspace_id, email) unique violation → a concurrent retry won the
      // race; re-query for the winner's row rather than failing the webhook.
      if ((err as any)?.code === '23505') {
        const [winner] = await sql<{ id: string }[]>`
          select id from customers where workspace_id = ${workspaceId} and email = ${email} and deleted_at is null
        `;
        if (!winner) throw new Error('Customer race recovery failed: row not visible after unique violation');
        customerId = winner.id;
        // isNewCustomer stays false — the other request created it.
      } else {
        throw new Error(`Customer create failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 2. Create the ticket. Status/priority/category are best-guess defaults;
  //    auto-triage may overwrite them.
  const ticketDisplayId = await nextDisplayId(sql, workspaceId, 'ticket');
  const [newTicket] = await sql<{ id: string; display_id: string }[]>`
    insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, sla_state)
    values (${workspaceId}, ${ticketDisplayId}, ${subject}, ${customerId}, 'open', 'normal', 'ok')
    returning id, display_id
  `;
  if (!newTicket) throw new Error('Ticket create failed');

  // 3. First message from the email body. The RFC Message-ID is stored so we
  //    can thread our reply via In-Reply-To when auto-reply fires.
  const authorLabel = name?.trim() || email;
  const [newMessage] = await sql<{ id: string }[]>`
    insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
    values (${workspaceId}, ${newTicket.id}, 'customer', ${authorLabel}, ${body}, ${externalMessageId})
    returning id
  `;
  if (!newMessage) throw new Error('Message create failed');
  void scoreInboundMessage({ workspaceId, ticketId: newTicket.id, messageId: newMessage.id, body });

  // 3b. Audit row in the inbox view. Failures are logged but don't fail
  //     the webhook — the customer-facing ticket has already been created.
  const to = parseTo(payload);
  await recordInboundInInbox({ workspaceId, payload, ticketId: newTicket.id, toEmail: to?.email ?? null });

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

  void publishTicketChanged(workspaceId, newTicket.id);
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
  const { workspaceId, ticketId, ticketDisplayId, customerId, body, name, email, externalMessageId, payload } = args;
  const sql = getDb();

  const authorLabel = name?.trim() || email;
  const [replyMessage] = await sql<{ id: string }[]>`
    insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
    values (${workspaceId}, ${ticketId}, 'customer', ${authorLabel}, ${body}, ${externalMessageId})
    returning id
  `;
  if (!replyMessage) throw new Error('Reply attach failed');
  void scoreInboundMessage({ workspaceId, ticketId, messageId: replyMessage.id, body });

  // Audit the threaded reply in the inbox view too, so the agent can see
  // the email arrived even if they don't immediately notice the ticket
  // updated. Same fire-and-forget treatment as the new-ticket path.
  const to = parseTo(payload);
  await recordInboundInInbox({ workspaceId, payload, ticketId, toEmail: to?.email ?? null });

  // Fire-and-forget retriage so the AI draft refreshes with the new turn.
  // Errors swallowed (same rationale as the create path) so Postmark gets 200.
  let autoTriageQueued = false;
  try {
    void triageTicket({ ticketId, workspaceId, userId: null }).catch((err) => {
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

  // Push the assigned agent if they're not currently in the app (offline-agent
  // notifications, stage 3). Awaited so the work isn't dropped on serverless
  // freeze; fully guarded so a push hiccup never fails the inbound webhook.
  try { await pushOfflineAssignee(workspaceId, ticketId); }
  catch (err) { console.warn('[push] offline-assignee notify failed:', err instanceof Error ? err.message : err); }

  void publishTicketChanged(workspaceId, ticketId);
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

// Notify the ticket's assigned agent of a new customer reply via Web Push, but
// ONLY when they're offline (an agent in the app already gets the live toast/
// bell) and we haven't already pushed about this turn. last_reply_notified_at
// throttles a fast back-and-forth to a single push until the agent replies
// (which clears it — see POST /:id/messages). No-ops when push is unconfigured
// or the ticket is unassigned (e.g. the unrouted bucket).
async function pushOfflineAssignee(workspaceId: string, ticketId: string): Promise<void> {
  if (!isPushConfigured()) return;
  const sql = getDb();
  const [t] = await sql<{ assigned_user_id: string | null; notified: string | null; subject: string; slug: string; display_id: string }[]>`
    select t.assigned_user_id, t.last_reply_notified_at as notified, t.subject, t.display_id, w.slug
    from tickets t join workspaces w on w.id = t.workspace_id
    where t.id = ${ticketId} and t.workspace_id = ${workspaceId}
  `;
  if (!t?.assigned_user_id) return;                       // unassigned — nobody to notify
  if (t.notified) return;                                 // already pushed this turn; wait for the agent to act
  if (await isUserActive(t.assigned_user_id)) return;     // in the app — the in-app toast/bell covers it

  const url = `/?ws=${encodeURIComponent(t.slug || '')}#ticket/${encodeURIComponent(t.display_id)}`;
  const res = await sendPushToUser(t.assigned_user_id, {
    title: 'New customer reply',
    body: `${t.display_id} — ${t.subject}`.slice(0, 140),
    url,
    tag: `ticket-${ticketId}`,
  });
  if (res.sent > 0) {
    await sql`update tickets set last_reply_notified_at = now() where id = ${ticketId} and workspace_id = ${workspaceId}`;
  }
}
