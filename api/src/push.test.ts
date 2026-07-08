// Web Push subscriptions + delivery (push stage 2). DB-backed (RUN_DB_TESTS).
// Uses a real generated VAPID keypair so isPushConfigured()/setVapidDetails
// accept it, and stubs webpush.sendNotification so no network is hit — letting
// us assert the dead-subscription (410) pruning.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import webpush from 'web-push';

// VAPID + other hermetic env are set in test-setup.ts (the bun preload), which
// runs before env.ts parses — so Web Push reads as configured regardless of
// which test file loads first.
const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('web push subscriptions + delivery (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let sendPushToUser: typeof import('./lib/push.js').sendPushToUser;

  const RUN = Date.now();
  const ctx = {} as Record<string, string>;
  const realSend = webpush.sendNotification;

  function auth(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${ctx.token}`);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    sendPushToUser = (await import('./lib/push.js')).sendPushToUser;
    const { auth: betterAuth } = await import('./lib/auth.js');
    const r: any = await betterAuth.api.signUpEmail({ body: { email: `push-${RUN}@t.test`, password: 'password-12345', name: 'P' }, returnHeaders: true });
    ctx.userId = r.response.user.id; ctx.token = r.response.token;
  }, 30000);

  beforeEach(() => { webpush.sendNotification = realSend; });
  afterAll(async () => {
    webpush.sendNotification = realSend;
    await sql`delete from push_subscriptions where user_id = ${ctx.userId}`;
  });

  it('subscribes a browser, then unsubscribes it', async () => {
    const sub = { endpoint: `https://push.example.com/${RUN}/a`, keys: { p256dh: 'pubkey-a', auth: 'authsecret-a' } };
    const res = await auth('/api/v1/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
    expect(res.status).toBe(201);
    const [row] = await sql<{ user_id: string }[]>`select user_id from push_subscriptions where endpoint = ${sub.endpoint}`;
    expect(row.user_id).toBe(ctx.userId);

    const un = await auth('/api/v1/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
    expect(un.status).toBe(200);
    const after = await sql`select 1 from push_subscriptions where endpoint = ${sub.endpoint}`;
    expect(after).toHaveLength(0);
  });

  it('sends to live subscriptions and prunes dead (410) ones', async () => {
    const alive = `https://push.example.com/${RUN}/alive`;
    const dead  = `https://push.example.com/${RUN}/dead`;
    await sql`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values
      (${ctx.userId}, ${alive}, 'p', 'a'), (${ctx.userId}, ${dead}, 'p', 'a')`;

    // Stub: the dead endpoint returns 410 Gone, the live one succeeds.
    webpush.sendNotification = (async (subscription: any) => {
      if (subscription.endpoint === dead) { const e: any = new Error('gone'); e.statusCode = 410; throw e; }
      return { statusCode: 201 } as any;
    }) as any;

    const result = await sendPushToUser(ctx.userId, { title: 'T', body: 'B', url: '/' });
    expect(result.sent).toBe(1);
    expect(result.pruned).toBe(1);

    const rows = await sql<{ endpoint: string }[]>`select endpoint from push_subscriptions where user_id = ${ctx.userId}`;
    const endpoints = rows.map((r) => r.endpoint);
    expect(endpoints).toContain(alive);     // live one kept
    expect(endpoints).not.toContain(dead);  // dead one pruned
  });
});
