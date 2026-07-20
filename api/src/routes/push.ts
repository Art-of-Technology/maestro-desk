import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuthOnly } from '../middleware/auth.js';
import { getDb } from '../lib/db.js';
import { env } from '../lib/env.js';
import { isPushConfigured, sendPushToUser } from '../lib/push.js';
import { assertSafePushEndpoint } from '../lib/ssrf.js';

// Web Push subscription management (push stage 2). All routes are user-scoped
// (requireAuthOnly — a push subscription belongs to a browser/user, not a
// workspace), so no X-Workspace-Id is needed. Delivery (pushing the offline
// assigned agent on a reply) is wired in stage 3.
export const push = new Hono();

// GET /config — the client needs the VAPID public key to subscribe, plus a
// flag so the SPA can hide the opt-in entirely when push isn't configured.
push.get('/config', requireAuthOnly, (c) =>
  c.json({ configured: isPushConfigured(), public_key: env.VAPID_PUBLIC_KEY || null }),
);

// Standard PushSubscription.toJSON() shape from the browser. Deliberately NOT
// .strict(): toJSON() also carries expirationTime (Chrome sends null) and the
// spec may grow more fields — unknown keys are stripped (zod default) so a new
// browser field can never 400 real subscribes. Nothing beyond endpoint+keys is
// read or stored (explicit destructure + explicit insert columns below), and
// expiry needs no handling — dead endpoints are pruned on 404/410 at send time.
const Subscribe = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
});

// POST /subscribe — upsert this browser's subscription for the caller. Keyed on
// the unique endpoint: re-subscribing (keys rotated, or a different user on the
// same browser) refreshes the row and re-owns it.
push.post('/subscribe', requireAuthOnly, async (c) => {
  if (!isPushConfigured()) return c.json({ error: 'Push not configured' }, 503);
  const userId = c.get('userId');
  const parsed = Subscribe.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid subscription', issues: parsed.error.issues }, 400);
  const { endpoint, keys } = parsed.data;
  // SSRF guard: the endpoint is a user-supplied URL the server will POST to
  // later (sendPushToUser). Reject non-https / private / internal targets at
  // write time so a malicious endpoint is never stored. (Rebinding of a stored
  // endpoint is caught again at connect time by the https.Agent in lib/push.ts.)
  try {
    await assertSafePushEndpoint(endpoint);
  } catch {
    return c.json({ error: 'Invalid push endpoint' }, 400);
  }
  const ua = c.req.header('user-agent')?.slice(0, 400) ?? null;

  const sql = getDb();
  await sql`
    insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (${userId}, ${endpoint}, ${keys.p256dh}, ${keys.auth}, ${ua})
    on conflict (endpoint) do update
      set user_id = excluded.user_id, p256dh = excluded.p256dh,
          auth = excluded.auth, user_agent = excluded.user_agent, last_used_at = null
  `;
  return c.json({ ok: true }, 201);
});

// POST /unsubscribe — remove this browser's subscription (only the caller's own).
const Unsubscribe = z.object({ endpoint: z.string().url().max(2048) }).strict();
push.post('/unsubscribe', requireAuthOnly, async (c) => {
  const userId = c.get('userId');
  const parsed = Unsubscribe.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400);
  const sql = getDb();
  await sql`delete from push_subscriptions where endpoint = ${parsed.data.endpoint} and user_id = ${userId}`;
  return c.json({ ok: true });
});

// POST /test — send a test push to the caller's own devices, so an agent can
// verify the pipe end-to-end from Settings right after opting in.
push.post('/test', requireAuthOnly, async (c) => {
  if (!isPushConfigured()) return c.json({ error: 'Push not configured' }, 503);
  const userId = c.get('userId');
  const result = await sendPushToUser(userId, {
    title: 'Respovia',
    body: 'Notifications are on — you’ll be alerted here when a customer replies.',
    url: '/',
    tag: 'push-test',
  });
  return c.json(result);
});
