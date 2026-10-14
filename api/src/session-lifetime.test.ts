import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { once } from 'node:events';
import { serve } from '@hono/node-server';

const dbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
dbTests('eight-hour agent sessions', () => {
  const ids: string[] = [];
  afterAll(async () => {
    const sql = (await import('./lib/db.js')).getDb();
    if (ids.length) await sql`delete from users where id in ${sql(ids)}`;
  });

  it('browser sign-out revokes its server session while clearing local state immediately', async () => {
    const { auth } = await import('./lib/auth.js');
    const app = (await import('./index.js')).default;
    const { env } = await import('./lib/env.js');
    const email = `signout-${crypto.randomUUID()}@example.test`;
    const password = 'Signout-test-password-123!';
    const result = await auth.api.signUpEmail({ body: { email, password, name: 'Sign-out test' }, returnHeaders: true });
    ids.push(result.response.user.id);
    let jwt: string | null = result.headers.get('set-auth-token')!;
    const headers = new Headers({ Authorization: `Bearer ${jwt}` });
    const other = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const otherHeaders = new Headers({ Authorization: `Bearer ${other.headers.get('set-auth-token')}` });
    expect(await auth.api.getSession({ headers })).not.toBeNull();
    let workspace: string | null = 'workspace';
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port');
    try {
      let revocation: Promise<Response> | undefined;
      const stored = new Map([['maestro_user', JSON.stringify({ id: ids.at(-1) })], ['respovia_session_warning', 'warned']]);
      const source = readFileSync(new URL('../../web/js/core/auth-client.js', import.meta.url), 'utf8')
        .replace(/^import .+;\r?$/gm, '').replace(/^export /gm, '');
      const translations = Promise.resolve();
      const signOut = runInNewContext(source + '\nsignOut;', {
        window: new EventTarget(), CustomEvent,
        sessionStorage: { getItem: (key: string) => stored.get(key), removeItem: (key: string) => stored.delete(key) },
        API_BASE: `http://127.0.0.1:${address.port}`, getJwt: () => jwt, setJwt: (value: null) => { jwt = value; },
        setWorkspaceId: (value: null) => { workspace = value; }, stopSessionLifetime: () => {},
        clearTranslationCache: () => translations,
        fetch: (url: string, options: RequestInit) => {
          const requestHeaders = new Headers(options.headers);
          requestHeaders.set('Origin', env.APP_BASE_URL);
          return revocation = fetch(url, { ...options, headers: requestHeaders });
        },
      });
      expect(signOut()).toBe(translations);
      expect(jwt).toBeNull();
      expect(workspace).toBeNull();
      expect(stored.size).toBe(0);
      expect(revocation).toBeDefined();
      expect((await revocation!).status).toBe(200);
      expect(await auth.api.getSession({ headers })).toBeNull();
      expect(await auth.api.getSession({ headers: otherHeaders })).not.toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('issues fixed sessions, caps legacy sessions, rejects expiry and permits a fresh login', async () => {
    const { auth } = await import('./lib/auth.js');
    const sql = (await import('./lib/db.js')).getDb();
    const email = `session-${crypto.randomUUID()}@example.test`;
    const password = 'Session-test-password-123!';
    const result = await auth.api.signUpEmail({ body: { email, password, name: 'Session test' }, returnHeaders: true });
    const userId = result.response.user.id;
    ids.push(userId);
    const token = result.headers.get('set-auth-token')!;
    expect(token).toBeTruthy();
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const first = await auth.api.getSession({ headers });
    expect(first).not.toBeNull();
    const lifetime = first!.session.expiresAt.getTime() - first!.session.createdAt.getTime();
    // Better Auth reads its expiry and creation clocks separately; the session
    // may be a few milliseconds shorter, but must never exceed eight hours.
    expect(lifetime).toBeLessThanOrEqual(8 * 3600000);
    expect(lifetime).toBeGreaterThan(8 * 3600000 - 1000);
    expect(auth.options.session?.disableSessionRefresh).toBe(true);

    // Simulate a legacy session older than updateAge. Activity must not renew it.
    await sql`update "session" set "createdAt" = now() - interval '3 days', "expiresAt" = now() + interval '10 minutes' where "userId" = ${userId}`;
    const [before] = await sql`select "expiresAt" from "session" where "userId" = ${userId}`;
    await auth.api.getSession({ headers });
    const [after] = await sql`select "expiresAt" from "session" where "userId" = ${userId}`;
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
    await sql`update "session" set "expiresAt" = now() + interval '5 minutes' where "userId" = ${userId}`;
    const [short] = await sql`select "expiresAt" from "session" where "userId" = ${userId}`;
    await sql.unsafe(migration);
    const [capped] = await sql`select "expiresAt" from "session" where "userId" = ${userId}`;
    expect(capped.expiresAt.getTime()).toBe(short.expiresAt.getTime());

    const noRemember = await auth.api.signInEmail({ body: { email, password, rememberMe: false }, returnHeaders: true });
    const noRememberSession = await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${noRemember.headers.get('set-auth-token')}` }) });
    expect(noRememberSession!.session.expiresAt.getTime() - noRememberSession!.session.createdAt.getTime()).toBe(8 * 3600000);
  });
});
