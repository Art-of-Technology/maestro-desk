// Audit #10: POST /customers/from-player must not let an agent pull a brand's
// player PII into a DIFFERENT workspace. The brand (X-Brand-Id) and the write
// target (X-Workspace-Id) must resolve to the same tenant. DB-backed.
//
// Both asserted paths short-circuit BEFORE the Maestro app-token call (the brand
// gate runs first), so no real gateway is needed — we only set MAESTRO_API_TOKEN
// so workerMaestroConfigured() lets the handler reach the check.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.MAESTRO_API_TOKEN ||= 'mh_live_test_token_placeholder';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('from-player tenant containment (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const agent = {} as Record<string, string>;
  const brandA = randomUUID();
  const brandB = randomUUID();
  const brandC = randomUUID();
  let wsA = '', wsB = '', wsC = '';
  const createdUserIds: string[] = [];

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: 'A' }, returnHeaders: true });
    createdUserIds.push(r.response.user.id);
    return { id: r.response.user.id, token: r.response.token };
  }
  async function provisionBrandWs(slug: string, brandId: string): Promise<string> {
    const [{ provision_brand: id }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slug}, ${slug}) as provision_brand`;
    await sql`update workspaces set maestro_brand_id = ${brandId} where id = ${id}`;
    return id;
  }
  async function addMember(wsId: string) {
    const [role] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${agent.userId}, ${role.id}, true)`;
  }
  function fromPlayer(wsHeader: string, brandHeader: string) {
    return app.request('/api/v1/customers/from-player', {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}`, 'X-Workspace-Id': wsHeader, 'X-Brand-Id': brandHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `player-${RUN}@example.com` }),
    });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const ua = await signUp(`fp-agent-${RUN}@t.test`);
    agent.userId = ua.id; agent.token = ua.token;
    wsA = await provisionBrandWs(`fpa-${RUN}`, brandA);
    wsB = await provisionBrandWs(`fpb-${RUN}`, brandB);
    wsC = await provisionBrandWs(`fpc-${RUN}`, brandC);
    await addMember(wsA);   // agent is a member of A and B, but NOT C
    await addMember(wsB);
  }, 30000);

  afterAll(async () => {
    if (!sql) return;
    for (const ws of [wsA, wsB, wsC].filter(Boolean)) {
      await sql`delete from customers where workspace_id = ${ws}`;
      await sql`delete from workspaces where id = ${ws}`;
    }
    if (createdUserIds.length) await sql`delete from users where id in ${sql(createdUserIds)}`;
  });

  it('rejects a brand whose workspace != the X-Workspace-Id (cross-tenant) with 400', async () => {
    const res = await fromPlayer(wsA, brandB);   // member of both, but headers mismatch
    expect(res.status).toBe(400);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from customers where workspace_id = ${wsA}`;
    expect(n).toBe(0);   // no PII written into wsA
  });

  it('rejects a brand the agent is not a member of with 403', async () => {
    const res = await fromPlayer(wsA, brandC);   // not a member of C's workspace
    expect(res.status).toBe(403);
  });
});
