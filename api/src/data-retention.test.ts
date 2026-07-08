// Data-retention purge + per-workspace window — DB-backed (RUN_DB_TESTS).
// Verifies the purge deletes only expired resolved tickets (cascading their
// children), respects a NULL window, and that the window is admin-configurable.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('data retention (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let purgeExpiredTickets: typeof import('./lib/retention.js').purgeExpiredTickets;

  const RUN = Date.now();
  const slug = `ret-${RUN}`;
  const slugHold = `ret-hold-${RUN}`;
  const admin = { email: `ret-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `ret-agent-${RUN}@t.test` } as Record<string, string>;
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
  // Seed a customer + ticket (customer_id is NOT NULL) with an explicit
  // resolved_at and a message child.
  async function seedTicket(wsId: string, display: string, resolvedAt: string | null): Promise<string> {
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name) values (${wsId}, ${'C-' + display}, 'C') returning id
    `;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, resolved_at)
      values (${wsId}, ${display}, 'S', ${cust.id}, ${resolvedAt ? 'resolved' : 'open'}, 'normal', ${resolvedAt})
      returning id
    `;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body) values (${wsId}, ${t.id}, 'customer', 'C', 'hi')`;
    return t.id;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    purgeExpiredTickets = (await import('./lib/retention.js')).purgeExpiredTickets;

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slug}, ${slug}) as provision_brand`;
    ctx.wsId = wsId;
    const [{ provision_brand: wsHold }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slugHold}, ${slugHold}) as provision_brand`;
    ctx.wsHold = wsHold;

    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and is_admin = true limit 1`;
    const [roRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and coalesce(is_admin,false) = false limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${agent.userId}, ${roRole.id}, true)`;

    // Main workspace: 1-year window. Hold workspace: NULL (purge disabled).
    await sql`update workspaces set retention_days = 365 where id = ${wsId}`;
    await sql`update workspaces set retention_days = null where id = ${wsHold}`;

    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    ctx.expired = await seedTicket(wsId, 'TK-old-' + slug, daysAgo(800));   // > 365 → purge
    ctx.recent = await seedTicket(wsId, 'TK-new-' + slug, daysAgo(10));     // < 365 → keep
    ctx.open = await seedTicket(wsId, 'TK-open-' + slug, null);            // unresolved → keep
    ctx.held = await seedTicket(wsHold, 'TK-hold-' + slugHold, daysAgo(5000)); // purge disabled → keep
  });

  afterAll(async () => {
    if (!sql) return;
    for (const id of [ctx.wsId, ctx.wsHold].filter(Boolean)) await sql`delete from workspaces where id = ${id}`;
    const ids = [admin.userId, agent.userId].filter(Boolean);
    if (ids.length) await sql`delete from users where id in ${sql(ids)}`;
  });

  it('defaults retention_days to 1825 (5 years)', async () => {
    // Fresh workspace (provisioned without an override) carries the column default.
    const [{ provision_brand: fresh }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'ret-def-' + RUN}, ${'ret-def-' + RUN}) as provision_brand`;
    const [w] = await sql<{ retention_days: number }[]>`select retention_days from workspaces where id = ${fresh}`;
    expect(w.retention_days).toBe(1825);
    await sql`delete from workspaces where id = ${fresh}`;
  });

  it('purges only expired resolved tickets, cascading their children', async () => {
    const before = await sql<{ n: number }[]>`select count(*)::int as n from ticket_messages where ticket_id = ${ctx.expired}`;
    expect(before[0].n).toBe(1);

    const { purgedTickets } = await purgeExpiredTickets();
    expect(purgedTickets).toBeGreaterThanOrEqual(1);

    const survivors = await sql<{ id: string }[]>`select id from tickets where workspace_id = ${ctx.wsId}`;
    const ids = survivors.map((r) => r.id);
    expect(ids).not.toContain(ctx.expired);   // expired → gone
    expect(ids).toContain(ctx.recent);        // within window → kept
    expect(ids).toContain(ctx.open);          // unresolved → never purged

    // Child messages of the purged ticket are gone (FK cascade).
    const after = await sql<{ n: number }[]>`select count(*)::int as n from ticket_messages where ticket_id = ${ctx.expired}`;
    expect(after[0].n).toBe(0);
  });

  it('purges a large backlog across multiple batches', async () => {
    // Fresh workspace so the count is exact regardless of other tests' data.
    const bslug = `ret-batch-${RUN}`;
    const [{ provision_brand: wsB }] = await sql<{ provision_brand: string }[]>`select provision_brand(${bslug}, ${bslug}) as provision_brand`;
    await sql`update workspaces set retention_days = 365 where id = ${wsB}`;
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const N = 5;
    for (let i = 0; i < N; i++) await seedTicket(wsB, `TK-batch-${i}-${bslug}`, daysAgo(800));

    // batchSize 2 forces multiple iterations (ceil(5/2) = 3 batches).
    const before = await sql<{ n: number }[]>`select count(*)::int as n from tickets where workspace_id = ${wsB}`;
    expect(before[0].n).toBe(N);
    const { purgedTickets } = await purgeExpiredTickets(2);
    expect(purgedTickets).toBeGreaterThanOrEqual(N);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from tickets where workspace_id = ${wsB}`;
    expect(after[0].n).toBe(0);

    await sql`delete from workspaces where id = ${wsB}`;
  });

  it('never purges a workspace with retention disabled (NULL)', async () => {
    await purgeExpiredTickets();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from tickets where id = ${ctx.held}`;
    expect(n).toBe(1); // 5000 days old but purge disabled → retained
  });

  it('admins can configure the window; non-admins cannot', async () => {
    const forbidden = await as(agent.token, '/api/v1/workspace/settings', { method: 'PATCH', body: JSON.stringify({ retention_days: 730 }) });
    expect(forbidden.status).toBe(403);
    const ok = await as(admin.token, '/api/v1/workspace/settings', { method: 'PATCH', body: JSON.stringify({ retention_days: 730 }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).workspace.retention_days).toBe(730);
    // Below the floor is rejected.
    const tooLow = await as(admin.token, '/api/v1/workspace/settings', { method: 'PATCH', body: JSON.stringify({ retention_days: 5 }) });
    expect(tooLow.status).toBe(400);
  });
});
