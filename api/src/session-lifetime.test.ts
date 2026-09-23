import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const dbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
dbTests('eight-hour agent sessions', () => {
  const ids: string[] = [];
  afterAll(async () => {
    const sql = (await import('./lib/db.js')).getDb();
    if (ids.length) await sql`delete from users where id in ${sql(ids)}`;
  });

  it('issues fixed sessions, caps legacy sessions, rejects expiry and permits a fresh login', async () => {
    const { auth } = await import('./lib/auth.js');
    const sql = (await import('./lib/db.js')).getDb();
    const email = `session-${crypto.randomUUID()}@example.test`;
    const password = 'Session-test-password-123!';
    const result = await auth.api.signUpEmail({ body: { email, password, name: 'Session test' }, returnHeaders: true });
    ids.push(result.response.user.id);
    const token = result.headers.get('set-auth-token')!;
    expect(token).toBeTruthy();
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const first = await auth.api.getSession({ headers });
    expect(first).not.toBeNull();
    expect(first!.session.expiresAt.getTime() - first!.session.createdAt.getTime()).toBe(8 * 3600000);
    expect(auth.options.session?.disableSessionRefresh).toBe(true);

    // Simulate a legacy session older than updateAge. Activity must not renew it.
    await sql`update "session" set "createdAt" = now() - interval '3 days', "expiresAt" = now() + interval '10 minutes' where "userId" = ${ids[0]}`;
    const [before] = await sql`select "expiresAt" from "session" where "userId" = ${ids[0]}`;
    await auth.api.getSession({ headers });
    const [after] = await sql`select "expiresAt" from "session" where "userId" = ${ids[0]}`;
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());

    const migration = readFileSync(new URL('../../db/migrations/20260923120000_eight_hour_agent_sessions.sql', import.meta.url), 'utf8');
    await sql.unsafe(migration);
    expect(await auth.api.getSession({ headers })).toBeNull();
    const { Hono } = await import('hono');
    const { requireAuth, requireAuthOnly } = await import('./middleware/auth.js');
    const { requirePlatformAdmin } = await import('./middleware/platform-admin.js');
    for (const middleware of [requireAuth, requireAuthOnly, requirePlatformAdmin]) {
      const app = new Hono().get('/', middleware, c => c.text('allowed'));
      expect((await app.request('/', { headers })).status).toBe(401);
    }

    const fresh = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const freshHeaders = new Headers({ Authorization: `Bearer ${fresh.headers.get('set-auth-token')}` });
    const { whoami } = await import('./routes/whoami.js');
    const response = await whoami.request('/', { headers: freshHeaders });
    expect(response.status).toBe(200);
    const body = await response.json() as { session: { expiresAt: string; serverTime: string } };
    const remaining = Date.parse(body.session.expiresAt) - Date.parse(body.session.serverTime);
    expect(remaining).toBeGreaterThan(8 * 3600000 - 10000);
    expect(remaining).toBeLessThanOrEqual(8 * 3600000);

    // A shorter existing expiry must never be lengthened by the migration.
    await sql`update "session" set "expiresAt" = now() + interval '5 minutes' where "userId" = ${ids[0]}`;
    const [short] = await sql`select "expiresAt" from "session" where "userId" = ${ids[0]}`;
    await sql.unsafe(migration);
    const [capped] = await sql`select "expiresAt" from "session" where "userId" = ${ids[0]}`;
    expect(capped.expiresAt.getTime()).toBe(short.expiresAt.getTime());

    const noRemember = await auth.api.signInEmail({ body: { email, password, rememberMe: false }, returnHeaders: true });
    const noRememberSession = await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${noRemember.headers.get('set-auth-token')}` }) });
    expect(noRememberSession!.session.expiresAt.getTime() - noRememberSession!.session.createdAt.getTime()).toBe(8 * 3600000);
  });
});
