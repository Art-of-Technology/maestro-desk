// Fan-out dispatcher for the workspace_webhooks table. Mirrors
// slack-notify.ts's shape — same event taxonomy, same fire-and-forget
// semantics — but POSTs JSON to any URL the workspace configured,
// signed with an HMAC the workspace also chose.
//
// Receivers verify via:
//   compute(secret, `v0:${X-Maestro-Timestamp}:${rawBody}`) == X-Maestro-Signature
// modeled on Slack's pattern so we can reuse the verifier shape if we
// ever want a Maestro → Maestro chain.

import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type WebhookEvent =
  | 'ticket.created'
  | 'ticket.resolved'
  | 'ticket.escalated'
  | 'priority.urgent';

interface WebhookRow {
  id:      string;
  url:     string;
  secret:  string;
  events:  string[];
}

interface TicketRow {
  id:            string;
  display_id:    string;
  subject:       string;
  status_key:    string | null;
  priority_key:  string | null;
  category_key:  string | null;
  assigned_user_id: string | null;
  customers: { id: string; first_name: string | null; last_name: string | null; email: string | null; vip_tier: string | null; brand: string | null } | null;
}

function sign(secret: string, timestamp: string, body: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

/**
 * Dispatch a ticket event to every active webhook in the workspace
 * subscribed to that event. Fan-out is parallel; per-webhook errors
 * are logged + persisted onto the webhook row (last_delivery_*) but
 * don't propagate — a misconfigured external URL must not break the
 * user's ticket mutation.
 *
 * Returns the count of attempted deliveries (useful for tests; the
 * callers in tickets.ts ignore it).
 */
export async function dispatchTicketEvent(args: {
  sb:          SupabaseClient;
  workspaceId: string;
  event:       WebhookEvent;
  ticketId:    string;
}): Promise<number> {
  const { sb, workspaceId, event, ticketId } = args;

  const { data: webhooks } = await sb
    .from('workspace_webhooks')
    .select('id, url, secret, events')
    .eq('workspace_id', workspaceId)
    .eq('active', true);
  const subscribed = (webhooks as WebhookRow[] | null || []).filter(w => w.events.includes(event));
  if (subscribed.length === 0) return 0;

  // Fetch ticket + customer once, broadcast to N receivers.
  const { data: ticket } = await sb
    .from('tickets')
    .select(`
      id, display_id, subject, status_key, priority_key, category_key, assigned_user_id,
      customers(id, first_name, last_name, email, vip_tier, brand)
    `)
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!ticket) return 0;
  const t = ticket as unknown as TicketRow;

  const customer = t.customers || null;
  const payload = {
    event,
    fired_at:     new Date().toISOString(),
    workspace_id: workspaceId,
    ticket: {
      id:               t.id,
      display_id:       t.display_id,
      subject:          t.subject,
      status:           t.status_key,
      priority:         t.priority_key,
      category:         t.category_key,
      assigned_user_id: t.assigned_user_id,
    },
    customer: customer && {
      id:        customer.id,
      name:      [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null,
      email:     customer.email,
      vip_tier:  customer.vip_tier,
      brand:     customer.brand,
    },
  };
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  await Promise.all(subscribed.map(async (w) => {
    try {
      const res = await fetch(w.url, {
        method:  'POST',
        headers: {
          'Content-Type':         'application/json',
          'X-Maestro-Event':      event,
          'X-Maestro-Timestamp':  timestamp,
          'X-Maestro-Signature':  sign(w.secret, timestamp, body),
        },
        body,
        // Don't let a slow receiver hold the request thread. Abort
        // after 5 seconds — receivers should ack fast and process async.
        signal: AbortSignal.timeout(5000),
      });
      await sb.from('workspace_webhooks').update({
        last_delivery_at:     new Date().toISOString(),
        last_delivery_status: res.status,
        last_delivery_error:  res.ok ? null : `HTTP ${res.status}`,
      }).eq('id', w.id);
      if (!res.ok) {
        console.warn(`[outgoing-webhooks] ${w.url} returned ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[outgoing-webhooks] ${w.url} failed: ${msg}`);
      await sb.from('workspace_webhooks').update({
        last_delivery_at:     new Date().toISOString(),
        last_delivery_status: null,
        last_delivery_error:  msg.slice(0, 200),
      }).eq('id', w.id);
    }
  }));

  return subscribed.length;
}
