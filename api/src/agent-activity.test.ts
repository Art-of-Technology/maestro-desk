// Activity heartbeat — the /tickets/sync poll stamps users.last_active_at, and
// isUserActive() answers "in the app within the window" for offline-notification
// routing. DB-backed (RUN_DB_TESTS).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('agent activity heartbeat (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let isUserActive: typeof import('./lib/activity.js').isUserActive;

  const RUN = Date.now();
  const ctx = {} as Record<string, string>;

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    isUserActive = (await import('./lib/activity.js')).isUserActive;

    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email: `act-${RUN}@t.test`, password: 'password-12345', name: 'Act' }, returnHeaders: true });
    ctx.userId = r.response.user.id; ctx.token = r.response.token;
    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'act-' + RUN}, ${'act-' + RUN}) as provision_brand`;
    ctx.wsId = ws;
    const [role] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${ctx.userId}, ${role.id}, true)`;
  }, 30000);

  afterAll(async () => {
    await sql`update users set last_active_at = null where id = ${ctx.userId}`;
  });

  it('starts inactive, then a /sync poll stamps last_active_at → active', async () => {
    expect(await isUserActive(ctx.userId, 300)).toBe(false);   // never polled
    const res = await app.request('/api/v1/tickets/sync?cursor=2020-01-01T00:00:00.000Z|', {
      headers: { Authorization: `Bearer ${ctx.token}`, 'X-Workspace-Id': ctx.wsId },
    });
    expect(res.status).toBe(200);
    expect(await isUserActive(ctx.userId, 300)).toBe(true);    // stamped by the poll
  });

  it('respects the activity window', async () => {
    await sql`update users set last_active_at = now() - interval '10 minutes' where id = ${ctx.userId}`;
    expect(await isUserActive(ctx.userId, 300)).toBe(false);    // 10 min ago > 5 min window → offline
    expect(await isUserActive(ctx.userId, 3600)).toBe(true);    // within a 1 h window → online
  });
});
