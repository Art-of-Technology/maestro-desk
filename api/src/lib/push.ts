import webpush from 'web-push';
import { Agent } from 'node:https';
import { env } from './env.js';
import { getDb } from './db.js';
import { safeLookup } from './ssrf.js';

// Connect-time SSRF guard for the outbound push POST (audit follow-up). web-push
// uses node https.request (not fetch), so the undici dispatcher used for
// webhooks doesn't apply — instead we hand it an https.Agent whose DNS lookup
// re-runs the block-list on the exact address dialed, defeating a rebind of a
// stored endpoint. web-push honors an `agent` that is an https.Agent instance.
// keepAlive stays off (default): a push is a one-shot POST, nothing to reuse.
// The write-time assertSafePushEndpoint check remains the portable guard for
// any runtime that doesn't honor Agent `lookup` (prod is Node, which does).
let pushAgent: Agent | undefined;
function safePushAgent(): Agent {
  return (pushAgent ??= new Agent({ lookup: safeLookup }));
}

// Web Push delivery for offline-agent notifications. VAPID-gated: when the
// keypair is unset the whole feature no-ops (isPushConfigured() === false),
// mirroring the Pubby/Sentry gating — so non-prod and unconfigured deploys
// behave exactly as before.

let configured: boolean | null = null;

export function isPushConfigured(): boolean {
  if (configured === null) {
    configured = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
    if (configured) {
      webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    }
  }
  return configured;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;        // SPA path/hash to open on click
  tag?: string;        // collapse key — a newer push with the same tag replaces the old one
}

export interface PushResult { sent: number; pruned: number }

// Send a push to every registered device for a user. Best-effort: each send is
// independent, and a 404/410 (subscription gone — browser unsubscribed or
// expired) prunes that row so we don't keep trying. Other errors are logged
// and skipped. Never throws — callers (the inbound webhook) must not fail on a
// push hiccup. No-ops when VAPID isn't configured.
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushResult> {
  if (!isPushConfigured()) return { sent: 0, pruned: 0 };
  const sql = getDb();

  const subs = await sql<{ id: string; endpoint: string; p256dh: string; auth: string }[]>`
    select id, endpoint, p256dh, auth from push_subscriptions where user_id = ${userId}
  `;
  if (subs.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  const dead: string[] = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        {
          TTL: 60 * 60,             // hold up to 1h if the device is offline, then drop
          agent: safePushAgent(),   // connect-time SSRF re-validation (see above)
        },
      );
      sent++;
    } catch (err: any) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        dead.push(s.id);   // subscription is gone — prune it
      } else {
        console.warn(`[push] send failed for sub ${s.id}: ${err?.message ?? err}`);
      }
    }
  }));

  if (dead.length > 0) {
    try { await sql`delete from push_subscriptions where id = any(${dead})`; }
    catch (err) { console.warn('[push] prune failed:', err instanceof Error ? err.message : err); }
  }
  if (sent > 0) {
    try { await sql`update push_subscriptions set last_used_at = now() where user_id = ${userId}`; }
    catch { /* best-effort */ }
  }
  return { sent, pruned: dead.length };
}
