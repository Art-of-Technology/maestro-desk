// roles.can_delete — the second enforced per-role capability (Phase 2 of the
// Aug-2026 update programme). Covers: provisioning seeds, roles CRUD carrying
// the flag, admin-gated PATCH, and whoami's implicit-admin shaping.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

// env.ts validates process.env at import; provide hermetic fallbacks so the
// suite can be parsed without a real api/.env. `||=` keeps real values when set.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('roles.can_delete (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const admin = { email: `cd-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `cd-agent-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(token: string, wsId: string, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', wsId);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'cd-' + RUN}, ${'cd-' + RUN}) as provision_brand`;
    ctx.ws = ws;

    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    const [plainRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and name = 'Read Only' limit 1`;
    ctx.plainRoleId = plainRole.id;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${agent.userId}, ${plainRole.id}, true)`;
  }, 30000);

  afterAll(async () => {
    await sql`delete from workspace_members where workspace_id = ${ctx.ws}`;
  }, 15000);

  it('provision_brand seeds can_delete: Admin true, everyone else false', async () => {
    const rows = await sql<{ name: string; can_delete: boolean }[]>`
      select name, can_delete from roles where workspace_id = ${ctx.ws} order by name
    `;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.can_delete]));
    expect(byName['Admin']).toBe(true);
    expect(byName['Senior Agent']).toBe(false);
    expect(byName['Read Only']).toBe(false);
  });

  it('GET /roles returns the flag; POST /roles accepts it (admin only)', async () => {
    const list = await as(admin.token, ctx.ws, '/api/v1/roles');
    const { roles } = await list.json() as any;
    expect(roles.every((r: any) => typeof r.can_delete === 'boolean')).toBe(true);

    const denied = await as(agent.token, ctx.ws, '/api/v1/roles', {
      method: 'POST', body: JSON.stringify({ name: 'Nope', can_delete: true }),
    });
    expect(denied.status).toBe(403);

    const ok = await as(admin.token, ctx.ws, '/api/v1/roles', {
      method: 'POST', body: JSON.stringify({ name: `Cleaner-${RUN}`, can_delete: true }),
    });
    expect(ok.status).toBe(201);
    const { role } = await ok.json() as any;
    expect(role.can_delete).toBe(true);
    expect(role.is_admin).toBe(false);
    ctx.cleanerRoleId = role.id;
  });

  it('PATCH /roles/:id toggles can_delete (admin only)', async () => {
    const denied = await as(agent.token, ctx.ws, `/api/v1/roles/${ctx.cleanerRoleId}`, {
      method: 'PATCH', body: JSON.stringify({ can_delete: false }),
    });
    expect(denied.status).toBe(403);

    const off = await as(admin.token, ctx.ws, `/api/v1/roles/${ctx.cleanerRoleId}`, {
      method: 'PATCH', body: JSON.stringify({ can_delete: false }),
    });
    expect(off.status).toBe(200);
    expect((await off.json() as any).role.can_delete).toBe(false);

    const on = await as(admin.token, ctx.ws, `/api/v1/roles/${ctx.cleanerRoleId}`, {
      method: 'PATCH', body: JSON.stringify({ can_delete: true }),
    });
    expect((await on.json() as any).role.can_delete).toBe(true);
  });

  it('whoami shapes can_delete: admin implicitly true, plain member false, flagged role true', async () => {
    const a = await as(admin.token, ctx.ws, '/api/v1/whoami');
    const am = (await a.json() as any).memberships.find((m: any) => m.workspace_id === ctx.ws);
    expect(am.can_delete).toBe(true);

    const g1 = await as(agent.token, ctx.ws, '/api/v1/whoami');
    const gm1 = (await g1.json() as any).memberships.find((m: any) => m.workspace_id === ctx.ws);
    expect(gm1.can_delete).toBe(false);

    // Move the agent onto the flagged role — whoami now carries true without
    // the role being admin.
    await sql`update workspace_members set role_id = ${ctx.cleanerRoleId} where workspace_id = ${ctx.ws} and user_id = ${agent.userId}`;
    const g2 = await as(agent.token, ctx.ws, '/api/v1/whoami');
    const gm2 = (await g2.json() as any).memberships.find((m: any) => m.workspace_id === ctx.ws);
    expect(gm2.can_delete).toBe(true);
    expect(gm2.is_admin).toBe(false);
  });
});
