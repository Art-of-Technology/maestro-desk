// Outgoing webhook fan-out + retry pipeline.
//
// Architecture: dispatchTicketEvent ENQUEUES rows in webhook_deliveries
// (one per subscribed webhook). A background worker (started in
// api/src/index.ts) polls the table every ~5s and attempts pending
// deliveries whose backoff timer has elapsed. On failure, the worker
// schedules the next attempt with exponential backoff. After
// MAX_ATTEMPTS the row is parked in state='exhausted' (the DLQ).
//
// HTTP semantics:
//   - 2xx                  → success, no further attempts
//   - 4xx (except 408/429) → permanent rejection, exhausted immediately
//                            (the receiver said "no, never" — retries
//                             won't change the answer)
//   - 5xx / 408 / 429      → transient, retry with backoff
//   - network errors       → transient
//
// Receivers verify via:
//   hmac_sha256(secret, `v0:${X-Maestro-Timestamp}:${rawBody}`)
//     === X-Maestro-Signature  (with the "v0=" prefix stripped)

import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type WebhookEvent =
  | 'ticket.created'
  | 'ticket.resolved'
  | 'ticket.escalated'
  | 'priority.urgent';

// Backoff schedule in seconds. Index = attempts already made.
// attempts=0 (just enqueued) → fire ASAP
// attempts=1 → wait 60s
// attempts=2 → wait 5min
// ...etc. After BACKOFF.length attempts, exhausted.
const BACKOFF_SECONDS = [60, 5 * 60, 30 * 60, 2 * 3600, 12 * 3600];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;  // initial + retries

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

interface WebhookRow {
  id:     string;
  events: string[];
}

function sign(secret: string, timestamp: string, body: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

/**
 * Enqueue ticket-event deliveries for every active webhook in the
 * workspace subscribed to this event. Returns the count of rows
 * enqueued (mostly for tests; tickets.ts ignores it).
 *
 * Synchronous: this builds the payload once and inserts rows. Actual
 * HTTP POSTs happen on the next worker tick. The poll interval is
 * short enough (5s) that observable latency is in the seconds, not
 * the minutes.
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
    .select('id, events')
    .eq('workspace_id', workspaceId)
    .eq('active', true);
  const subscribed = (webhooks as WebhookRow[] | null || []).filter(w => w.events.includes(event));
  if (subscribed.length === 0) return 0;

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

  const rows = subscribed.map((w) => ({
    workspace_id:    workspaceId,
    webhook_id:      w.id,
    event,
    payload,
    next_attempt_at: new Date().toISOString(),
  }));
  const { error } = await sb.from('webhook_deliveries').insert(rows);
  if (error) {
    console.error('[outgoing-webhooks] enqueue failed:', error.message);
    return 0;
  }
  return rows.length;
}

// ─── Worker side: process pending deliveries ─────────────────────────────

interface DeliveryRow {
  id:           string;
  webhook_id:   string;
  attempts:     number;
  payload:      any;
}

const PERMANENT_4XX_EXCEPTIONS = new Set([408, 429]);  // these are transient even though 4xx

export async function processPendingDeliveries(sb: SupabaseClient, limit = 50): Promise<{ processed: number }> {
  const now = new Date().toISOString();
  const { data: deliveries, error } = await sb
    .from('webhook_deliveries')
    .select('id, webhook_id, attempts, payload')
    .eq('state', 'pending')
    .lte('next_attempt_at', now)
    .order('next_attempt_at', { ascending: true })
    .limit(limit);
  if (error) {
    console.error('[webhook-worker] poll failed:', error.message);
    return { processed: 0 };
  }
  if (!deliveries || deliveries.length === 0) return { processed: 0 };

  // Load the parent webhooks once (id → url/secret) so we don't
  // round-trip per delivery. Same set we'd join inline; bulk-loading
  // is cheaper at our scale.
  const ids = Array.from(new Set(deliveries.map((d) => d.webhook_id)));
  const { data: webhookRows } = await sb
    .from('workspace_webhooks')
    .select('id, url, secret, active')
    .in('id', ids);
  const byId = new Map((webhookRows || []).map((w: any) => [w.id, w]));

  await Promise.all((deliveries as DeliveryRow[]).map(async (d) => {
    const wh = byId.get(d.webhook_id);
    // Parent webhook deleted or inactive between enqueue and delivery
    // — mark exhausted and skip. (active=false isn't permanent, but
    // we treat it as "stop trying" rather than holding queue depth.)
    if (!wh || !wh.active) {
      await markExhausted(sb, d.id, 0, 'webhook deleted or inactive');
      return;
    }
    await attemptDelivery(sb, d, wh);
  }));

  return { processed: deliveries.length };
}

async function attemptDelivery(sb: SupabaseClient, d: DeliveryRow, wh: { id: string; url: string; secret: string }) {
  const attempts = d.attempts + 1;
  const body = JSON.stringify(d.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  let status: number | null = null;
  let err: string | null = null;
  try {
    const res = await fetch(wh.url, {
      method:  'POST',
      headers: {
        'Content-Type':         'application/json',
        'X-Maestro-Event':      d.payload.event,
        'X-Maestro-Timestamp':  timestamp,
        'X-Maestro-Signature':  sign(wh.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    status = res.status;
    if (!res.ok) err = `HTTP ${res.status}`;
  } catch (e) {
    err = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
  }

  const succeeded = status !== null && status >= 200 && status < 300;
  const permanentFail = status !== null && status >= 400 && status < 500 && !PERMANENT_4XX_EXCEPTIONS.has(status);
  const exhausted = succeeded
    ? false
    : permanentFail || attempts >= MAX_ATTEMPTS;

  const updates: Record<string, unknown> = {
    attempts,
    last_status:     status,
    last_error:      err,
    last_attempt_at: new Date().toISOString(),
  };
  if (succeeded) {
    updates.state = 'success';
  } else if (exhausted) {
    updates.state = 'exhausted';
  } else {
    // Schedule the next attempt. attempts is the count INCLUDING the
    // one we just did, so the next backoff slot is at index (attempts-1).
    const seconds = BACKOFF_SECONDS[attempts - 1] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];
    updates.next_attempt_at = new Date(Date.now() + seconds * 1000).toISOString();
  }
  await sb.from('webhook_deliveries').update(updates).eq('id', d.id);

  // Mirror onto the parent row so the SPA's "last delivery" indicator
  // reflects the latest attempt across all deliveries.
  await sb.from('workspace_webhooks').update({
    last_delivery_at:     updates.last_attempt_at,
    last_delivery_status: status,
    last_delivery_error:  succeeded ? null : err,
  }).eq('id', wh.id);
}

async function markExhausted(sb: SupabaseClient, id: string, status: number | null, error: string) {
  await sb.from('webhook_deliveries').update({
    state: 'exhausted', last_status: status, last_error: error,
    last_attempt_at: new Date().toISOString(),
  }).eq('id', id);
}

// ─── Worker lifecycle ────────────────────────────────────────────────────
//
// Single setInterval tick driving processPendingDeliveries. Started
// from api/src/index.ts once after server boot. The interval is
// deliberately short (5s) so first-attempt latency stays sub-tick;
// retries are scheduled minutes/hours apart, so the tick just polls
// to find rows whose backoff elapsed.

const POLL_INTERVAL_MS = 5000;
let workerTimer: ReturnType<typeof setInterval> | null = null;

export function startWebhookWorker(sb: SupabaseClient): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    processPendingDeliveries(sb).catch((err) => {
      console.error('[webhook-worker] tick failed:', err);
    });
  }, POLL_INTERVAL_MS);
}

export function stopWebhookWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}
