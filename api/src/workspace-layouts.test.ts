// workspace_layouts — persisted admin Layouts (Phase 4, PR 3). Covers: the
// dense-set PUT replace + round-trip, the admin gate, the hidden-can't-be-
// required invariant, scope isolation, and empty-set-clears-back-to-defaults.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

// env.ts validates process.env at import; provide hermetic fallbacks so the
// suite can be parsed without a real api/.env. `||=` keeps real values when set.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('workspace layouts (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const admin = { email: `wl-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `wl-agent-${RUN}@t.test` } as Record<string, string>;
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
  const putScope = (token: string, scope: string, elements: unknown) =>
    as(token, ctx.ws, `/api/v1/workspace/layouts/${scope}`, { method: 'PUT', body: JSON.stringify({ elements }) });
  const getLayouts = async (token: string) => {
    const res = await as(token, ctx.ws, '/api/v1/workspace/layouts');
    expect(res.status).toBe(200);
    return ((await res.json()) as any).layouts as Array<{ scope: string; element_key: string; visible: boolean; required: boolean; sort_order: number }>;
  };

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'wl-' + RUN}, ${'wl-' + RUN}) as provision_brand`;
    ctx.ws = ws;

    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    const [plainRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and name = 'Read Only' limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${agent.userId}, ${plainRole.id}, true)`;
  }, 30000);

  afterAll(async () => {
    // Workspace delete cascades members + roles + workspace_layouts; then
    // drop the two signed-up users.
    await sql`delete from workspaces where id = ${ctx.ws}`;
    await sql`delete from users where id in (${admin.userId}, ${agent.userId})`;
  }, 15000);

  it('a fresh workspace has no persisted rows (code defaults apply)', async () => {
    expect(await getLayouts(admin.token)).toHaveLength(0);
  });

  it('any member may read; only an admin may write', async () => {
    expect(await getLayouts(agent.token)).toHaveLength(0);
    const res = await putScope(agent.token, 'ticket_form', [
      { element_key: 'priority', visible: false, required: false },
    ]);
    expect(res.status).toBe(403);
    expect(await getLayouts(admin.token)).toHaveLength(0);
  });

  it('PUT persists the full set and round-trips with dense array-index sort_order', async () => {
    const res = await putScope(admin.token, 'ticket_form', [
      { element_key: 'subject',  visible: true,  required: true },
      { element_key: 'tags',     visible: true,  required: false },
      { element_key: 'priority', visible: false, required: false },
    ]);
    expect(res.status).toBe(200);

    const rows = await getLayouts(admin.token);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.element_key)).toEqual(['subject', 'tags', 'priority']);
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1, 2]);
    expect(rows.find((r) => r.element_key === 'priority')!.visible).toBe(false);
    expect(rows.find((r) => r.element_key === 'subject')!.required).toBe(true);
  });

  it('a second PUT replaces the whole scope, not merges into it', async () => {
    const res = await putScope(admin.token, 'ticket_form', [
      { element_key: 'subject', visible: true, required: true },
      { element_key: 'agent',   visible: true, required: false },
    ]);
    expect(res.status).toBe(200);

    const keys = (await getLayouts(admin.token)).map((r) => r.element_key);
    expect(keys).toEqual(['subject', 'agent']);   // 'tags' and 'priority' are gone
  });

  it('scopes are independent: writing one leaves the other untouched', async () => {
    const res = await putScope(admin.token, 'customer_fields', [
      { element_key: 'mobile', visible: false, required: false },
    ]);
    expect(res.status).toBe(200);

    const rows = await getLayouts(admin.token);
    expect(rows.filter((r) => r.scope === 'ticket_form')).toHaveLength(2);
    expect(rows.filter((r) => r.scope === 'customer_fields')).toHaveLength(1);
  });

  it('rejects invalid payloads: hidden+required, duplicates, bad scope, required on areas', async () => {
    const hiddenRequired = await putScope(admin.token, 'ticket_form', [
      { element_key: 'priority', visible: false, required: true },
    ]);
    expect(hiddenRequired.status).toBe(400);

    const duplicate = await putScope(admin.token, 'ticket_form', [
      { element_key: 'subject', visible: true, required: true },
      { element_key: 'subject', visible: false, required: false },
    ]);
    expect(duplicate.status).toBe(400);

    const badScope = await putScope(admin.token, 'ticket_sidebar', [
      { element_key: 'subject', visible: true, required: false },
    ]);
    expect(badScope.status).toBe(404);

    const areaRequired = await putScope(admin.token, 'customer_areas', [
      { element_key: 'tickets', visible: true, required: true },
    ]);
    expect(areaRequired.status).toBe(400);

    // None of the rejects wrote anything.
    const rows = await getLayouts(admin.token);
    expect(rows.filter((r) => r.scope === 'ticket_form')).toHaveLength(2);
    expect(rows.filter((r) => r.scope === 'customer_areas')).toHaveLength(0);
  });

  it('an empty set clears the scope back to code defaults', async () => {
    const res = await putScope(admin.token, 'ticket_form', []);
    expect(res.status).toBe(200);

    const rows = await getLayouts(admin.token);
    expect(rows.filter((r) => r.scope === 'ticket_form')).toHaveLength(0);
    expect(rows.filter((r) => r.scope === 'customer_fields')).toHaveLength(1);  // untouched
  });
});
