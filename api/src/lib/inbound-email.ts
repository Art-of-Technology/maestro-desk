import type { SupabaseClient } from '@supabase/supabase-js';
import { parseFrom, pickBody, type PostmarkInbound } from './postmark.ts';
import { triageTicket } from './triage.ts';
import { BudgetExceededError } from './budget.ts';

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

// ─── Entry point ─────────────────────────────────────────────────────────

export interface InboundResult {
  ticket_id: string;
  ticket_display_id: string;
  customer_id: string;
  is_new_customer: boolean;
  auto_triage_queued: boolean;
}

/**
 * Convert an inbound email into a ticket. Steps:
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
    const [firstName, ...rest] = (name ?? email.split('@')[0]).split(/\s+/);
    const lastName = rest.join(' ') || null;
    const { data: newCustomer, error: ncErr } = await sb
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
    if (ncErr) throw new Error(`Customer create failed: ${ncErr.message}`);
    customerId = newCustomer.id;
    isNewCustomer = true;
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

  // 3. First message from the email body.
  const authorLabel = name?.trim() || email;
  const { error: mErr } = await sb.from('ticket_messages').insert({
    workspace_id: workspaceId,
    ticket_id: newTicket.id,
    role: 'customer',
    author_label: authorLabel,
    body,
  });
  if (mErr) throw new Error(`Message create failed: ${mErr.message}`);

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
  };
}
