// Outgoing webhook fan-out + retry pipeline.
//
// Architecture: dispatchTicketEvent ENQUEUES rows in webhook_deliveries (one
// per subscribed webhook) and flushes the first attempt immediately — inline
// via waitUntil on Vercel, or the in-process 5s worker (src/dev.ts) locally.
// Retries are swept by a daily Vercel Cron (routes/cron.ts) / the local
// worker, each attempt scheduled with exponential backoff. After MAX_ATTEMPTS
// the row is parked in state='exhausted' (the DLQ). processPendingDeliveries
// claims rows with FOR UPDATE SKIP LOCKED + a lease, so concurrent runners
// never double-deliver.
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
import { waitUntil } from '@vercel/functions';
import { getDb } from './db.ts';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().
// Outbound HTTP unchanged.

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
  workspaceId: string;
  event:       WebhookEvent;
  ticketId:    string;
}): Promise<number> {
  const { workspaceId, event, ticketId } = args;
  const sql = getDb();

  const webhooks = await sql<WebhookRow[]>`
    select id, events from workspace_webhooks where workspace_id = ${workspaceId} and active = true
  `;
  const subscribed = [...webhooks].filter((w) => w.events.includes(event));
  if (subscribed.length === 0) return 0;

  const [t] = await sql<{
    id: string; display_id: string; subject: string; status_key: string | null;
    priority_key: string | null; category_key: string | null; assigned_user_id: string | null;
    cust_id: string | null; first_name: string | null; last_name: string | null;
    email: string | null; vip_tier: string | null; brand: string | null;
  }[]>`
    select t.id, t.display_id, t.subject, t.status_key, t.priority_key, t.category_key, t.assigned_user_id,
           c.id as cust_id, c.first_name, c.last_name, c.email, c.vip_tier, c.brand
    from tickets t left join customers c on c.id = t.customer_id
    where t.id = ${ticketId} and t.workspace_id = ${workspaceId}
  `;
  if (!t) return 0;

  const customer = t.cust_id
    ? { id: t.cust_id, first_name: t.first_name, last_name: t.last_name, email: t.email, vip_tier: t.vip_tier, brand: t.brand }
    : null;
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

  try {
    for (const w of subscribed) {
      await sql`
        insert into webhook_deliveries (workspace_id, webhook_id, event, payload, next_attempt_at)
        values (${workspaceId}, ${w.id}, ${event}, ${sql.json(payload)}, now())
      `;
    }
  } catch (err) {
    console.error('[outgoing-webhooks] enqueue failed:', err instanceof Error ? err.message : err);
    return 0;
  }

  // Deliver immediately. On Vercel there's no always-on worker, so flush the
  // just-enqueued rows in the background via waitUntil — the first attempt
  // fires now without blocking the mutation response, and the daily cron is
  // only the retry sweep. Locally (Bun) the in-process worker (src/dev.ts)
  // picks them up within ~5s, so we skip the inline flush there. waitUntil
  // must run inside a request context (always true here — dispatchTicketEvent
  // is called from route handlers), hence the VERCEL guard.
  if (process.env.VERCEL) {
    waitUntil(
      processPendingDeliveries().then(
        () => {},
        (err) => console.error('[outgoing-webhooks] inline flush failed:', err instanceof Error ? err.message : err),
      ),
    );
  }
  return subscribed.length;
}

// ─── Worker side: process pending deliveries ─────────────────────────────

interface DeliveryRow {
  id:           string;
  webhook_id:   string;
  attempts:     number;
  payload:      any;
}

const PERMANENT_4XX_EXCEPTIONS = new Set([408, 429]);  // these are transient even though 4xx

export async function processPendingDeliveries(limit = 50): Promise<{ processed: number }> {
  const sql = getDb();
  let deliveries: DeliveryRow[];
  try {
    // Claim rows with a lease so concurrent runners (Vercel Cron + the inline
    // waitUntil flush, or any overlap) never deliver the same row twice:
    //   - FOR UPDATE SKIP LOCKED → concurrent claims get disjoint row sets.
    //   - bump next_attempt_at 30s out → a concurrent run's `next_attempt_at
    //     <= now()` filter skips these until this run finishes (attemptDelivery
    //     then sets the real state / backoff). If this run dies mid-delivery,
    //     the lease expires and the row is retried — at-least-once, which is
    //     the webhook contract (receivers dedupe via the signature).
    deliveries = [...await sql<DeliveryRow[]>`
      with claimed as (
        select id from webhook_deliveries
        where state = 'pending' and next_attempt_at <= now()
        order by next_attempt_at asc
        limit ${limit}
        for update skip locked
      )
      update webhook_deliveries d
      set next_attempt_at = now() + interval '30 seconds'
      from claimed
      where d.id = claimed.id
      returning d.id, d.webhook_id, d.attempts, d.payload
    `];
  } catch (err) {
    console.error('[webhook-worker] poll failed:', err instanceof Error ? err.message : err);
    return { processed: 0 };
  }
  if (deliveries.length === 0) return { processed: 0 };

  // Bulk-load the parent webhooks once (id → url/secret).
  const ids = Array.from(new Set(deliveries.map((d) => d.webhook_id)));
  const webhookRows = await sql<{ id: string; url: string; secret: string; active: boolean }[]>`
    select id, url, secret, active from workspace_webhooks where id = any(${ids})
  `;
  const byId = new Map(webhookRows.map((w) => [w.id, w]));

  await Promise.all(deliveries.map(async (d) => {
    const wh = byId.get(d.webhook_id);
    // Parent webhook deleted or inactive between enqueue and delivery — mark
    // exhausted and skip.
    if (!wh || !wh.active) {
      await markExhausted(d.id, 0, 'webhook deleted or inactive');
      return;
    }
    await attemptDelivery(d, wh);
  }));

  return { processed: deliveries.length };
}

async function attemptDelivery(d: DeliveryRow, wh: { id: string; url: string; secret: string }) {
  const sql = getDb();
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
  await sql`update webhook_deliveries set ${sql(updates)} where id = ${d.id}`;

  // Mirror onto the parent row so the SPA's "last delivery" indicator
  // reflects the latest attempt across all deliveries.
  await sql`
    update workspace_webhooks set
      last_delivery_at = ${updates.last_attempt_at as string},
      last_delivery_status = ${status},
      last_delivery_error = ${succeeded ? null : err}
    where id = ${wh.id}
  `;
}

async function markExhausted(id: string, status: number | null, error: string) {
  await getDb()`
    update webhook_deliveries
    set state = 'exhausted', last_status = ${status}, last_error = ${error}, last_attempt_at = now()
    where id = ${id}
  `;
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

export function startWebhookWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    processPendingDeliveries().catch((err) => {
      console.error('[webhook-worker] tick failed:', err);
    });
  }, POLL_INTERVAL_MS);
}

export function stopWebhookWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}
