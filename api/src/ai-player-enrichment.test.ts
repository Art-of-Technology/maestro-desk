// Per-workspace ai_player_enrichment toggle — DB-backed (RUN_DB_TESTS). Verifies
// the default-off posture and that only admins can flip it.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('ai_player_enrichment toggle (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const slug = `aipe-${RUN}`;
  const admin = { email: `aipe-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `aipe-agent-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(token: string, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', ctx.wsId);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;
    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slug}, ${slug}) as provision_brand`;
    ctx.wsId = wsId;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and is_admin = true limit 1`;
    const [roRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and coalesce(is_admin,false) = false limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${agent.userId}, ${roRole.id}, true)`;
  });

  afterAll(async () => {
    if (!sql) return;
    if (ctx.wsId) await sql`delete from workspaces where id = ${ctx.wsId}`;
    const ids = [admin.userId, agent.userId].filter(Boolean);
    if (ids.length) await sql`delete from users where id in ${sql(ids)}`;
  });

  it('defaults to false (data-minimising)', async () => {
    const res = await as(admin.token, '/api/v1/workspace/settings');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.workspace.ai_player_enrichment).toBe(false);
  });

  it('non-admins cannot toggle it (403)', async () => {
    const res = await as(agent.token, '/api/v1/workspace/settings', { method: 'PATCH', body: JSON.stringify({ ai_player_enrichment: true }) });
    expect(res.status).toBe(403);
  });

  it('an admin can opt in, and it round-trips', async () => {
    const patch = await as(admin.token, '/api/v1/workspace/settings', { method: 'PATCH', body: JSON.stringify({ ai_player_enrichment: true }) });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as any).workspace.ai_player_enrichment).toBe(true);
    const get = await as(admin.token, '/api/v1/workspace/settings');
    expect(((await get.json()) as any).workspace.ai_player_enrichment).toBe(true);
  });
});
