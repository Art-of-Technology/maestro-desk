// Cross-tenant isolation suite — the backstop that replaced Supabase RLS.
//
// After RLS was removed, the ONLY thing stopping a member of workspace A from
// reading/writing workspace B's data is (1) the requireAuth membership gate and
// (2) every route filtering by the validated workspace_id. These tests prove
// both against a REAL database by driving the actual Hono app with real Better
// Auth bearer sessions — only the network (Postmark/Anthropic) is never hit.
//
// DB-backed, so gated behind RUN_DB_TESTS (set in CI, where a Postgres service
// + applied migrations are available). A normal `bun test` without it skips
// this file. Run locally with:
//   docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=maestro_test -p 5432:5432 postgres:17
//   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/maestro_test?sslmode=disable' bun run migrate
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/tenant-isolation.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('tenant isolation (DB-backed)', () => {
  // Resolved in beforeAll.
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  // Per-workspace fixtures: { token (bearer), wsId, ticketId, ticketDisplayId,
  // customerId } for two fully separate tenants A and B.
  const A = { email: `iso-a-${RUN}@t.test`, slug: `iso-a-${RUN}` } as Record<string, string>;
  const B = { email: `iso-b-${RUN}@t.test`, slug: `iso-b-${RUN}` } as Record<string, string>;
  // C is a NON-admin member of tenant A, used to prove role management is
  // admin-gated (advisory GHSA-6qq2-v492-r8r6 — privilege escalation).
  const C = { email: `iso-c-${RUN}@t.test` } as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({
      body: { email, password: 'password-12345', name: email },
      returnHeaders: true,
    });
    return { id: r.response.user.id, token: r.response.token };
  }

  // Provision a workspace, make the user an active member, and seed one
  // customer + one ticket in it. Returns the seeded ids.
  async function setupTenant(t: Record<string, string>): Promise<void> {
    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${t.slug}, ${t.slug}) as provision_brand
    `;
    t.wsId = wsId;
    const [role] = await sql<{ id: string }[]>`
      select id from roles where workspace_id = ${wsId} and name = 'Admin'
    `;
    await sql`
      insert into workspace_members (workspace_id, user_id, role_id, active)
      values (${wsId}, ${t.userId}, ${role.id}, true)
    `;
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, email)
      values (${wsId}, ${'M-' + t.slug}, 'Cust', ${'cust-' + t.email})
      returning id
    `;
    t.customerId = cust.id;
    const [ticket] = await sql<{ id: string; display_id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${wsId}, ${'TK-' + t.slug}, ${'Secret of ' + t.slug}, ${cust.id}, 'open', 'normal')
      returning id, display_id
    `;
    t.ticketId = ticket.id;
    t.ticketDisplayId = ticket.display_id;
  }

  // app.request with the given member's bearer token + active workspace.
  function as(token: string | null, wsId: string | null, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (wsId) headers.set('X-Workspace-Id', wsId);
    return app.request(path, { ...init, headers });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const [ua, ub] = await Promise.all([signUp(A.email), signUp(B.email)]);
    A.userId = ua.id; A.token = ua.token;
    B.userId = ub.id; B.token = ub.token;
    await setupTenant(A);
    await setupTenant(B);

    // Add C as an ACTIVE, NON-admin member of tenant A under a fresh
    // is_admin=false role. This is the principal the role-management gate
    // must reject.
    const uc = await signUp(C.email);
    C.userId = uc.id; C.token = uc.token;
    const [memberRole] = await sql<{ id: string }[]>`
      insert into roles (workspace_id, name, is_admin)
      values (${A.wsId}, 'Member', false)
      returning id
    `;
    C.memberRoleId = memberRole.id;
    await sql`
      insert into workspace_members (workspace_id, user_id, role_id, active)
      values (${A.wsId}, ${C.userId}, ${memberRole.id}, true)
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    // Guard on populated ids so a partial beforeAll failure (e.g. signUp ok but
    // provision_brand threw) doesn't make teardown itself throw on undefined
    // and mask the real error. Cascades to members/tickets/customers/etc.
    const wsIds = [A.wsId, B.wsId].filter(Boolean);
    if (wsIds.length) await sql`delete from workspaces where id in ${sql(wsIds)}`;
    const userIds = [A.userId, B.userId, C.userId].filter(Boolean);
    if (userIds.length) await sql`delete from users where id in ${sql(userIds)}`;
    // NB: do NOT sql.end() — `sql` is the shared getDb() pool, so ending it
    // would break any DB-backed test file that runs after this one. The bun
    // test runner tears the process down at the end regardless.
  });

  it('A sees only A\'s tickets, never B\'s', async () => {
    const res = await as(A.token, A.wsId, '/api/v1/tickets');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const ids = (body.tickets ?? []).map((t: any) => t.display_id);
    expect(ids).toContain(A.ticketDisplayId);
    expect(ids).not.toContain(B.ticketDisplayId);
  });

  it('A cannot act as a workspace it is not a member of (403)', async () => {
    const res = await as(A.token, B.wsId, '/api/v1/tickets');
    expect(res.status).toBe(403);
  });

  it('A cannot fetch B\'s ticket by id even with its own valid workspace (404)', async () => {
    const res = await as(A.token, A.wsId, `/api/v1/tickets/${B.ticketId}`);
    expect(res.status).toBe(404);
  });

  it('A sees only A\'s customers, never B\'s', async () => {
    const res = await as(A.token, A.wsId, '/api/v1/customers');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const ids = (body.customers ?? []).map((c: any) => c.display_id);
    expect(ids).toContain('M-' + A.slug);
    expect(ids).not.toContain('M-' + B.slug);
  });

  it('rejects a request with no session (401)', async () => {
    const res = await as(null, A.wsId, '/api/v1/tickets');
    expect(res.status).toBe(401);
  });

  it('rejects a request with no X-Workspace-Id (400)', async () => {
    const res = await as(A.token, null, '/api/v1/tickets');
    expect(res.status).toBe(400);
  });

  it('symmetric: B cannot act as A\'s workspace (403)', async () => {
    const res = await as(B.token, A.wsId, '/api/v1/tickets');
    expect(res.status).toBe(403);
  });

  // ─── Role management is admin-only (GHSA-6qq2-v492-r8r6) ─────────────────
  // A non-admin member must not be able to create/edit roles — otherwise it
  // can flip its own role's is_admin and self-escalate to workspace admin.
  it('non-admin member cannot PATCH a role to is_admin (403, no write)', async () => {
    const res = await as(C.token, A.wsId, `/api/v1/roles/${C.memberRoleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_admin: true }),
    });
    expect(res.status).toBe(403);
    // Prove the guard ran BEFORE the write — the role must still be non-admin.
    const [role] = await sql<{ is_admin: boolean }[]>`
      select is_admin from roles where id = ${C.memberRoleId}
    `;
    expect(role.is_admin).toBe(false);
  });

  it('non-admin member cannot create a role (403)', async () => {
    const res = await as(C.token, A.wsId, '/api/v1/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `escalate-${RUN}`, is_admin: true }),
    });
    expect(res.status).toBe(403);
  });

  it('workspace admin can still manage roles (POST 201 + PATCH 200)', async () => {
    const created = await as(A.token, A.wsId, '/api/v1/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `QA-${RUN}`, is_admin: false }),
    });
    expect(created.status).toBe(201);
    const { role }: any = await created.json();
    const patched = await as(A.token, A.wsId, `/api/v1/roles/${role.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `QA-${RUN}-renamed` }),
    });
    expect(patched.status).toBe(200);
  });

  // ─── Integration management is admin-only (GHSA-6qq2-v492-r8r6 #2) ───────
  // A non-admin must not be able to create/repoint outgoing webhooks (which
  // would exfiltrate ticket payloads) or write the Slack integration.
  it('non-admin member cannot create an outgoing webhook (403)', async () => {
    const res = await as(C.token, A.wsId, '/api/v1/integrations/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'evil', url: 'https://example.com/hook', events: ['ticket.created'] }),
    });
    expect(res.status).toBe(403);
  });

  it('non-admin member cannot write the Slack integration (403)', async () => {
    const res = await as(C.token, A.wsId, '/api/v1/integrations/slack', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_url: 'https://hooks.slack.com/services/x', events: ['ticket.created'] }),
    });
    expect(res.status).toBe(403);
  });

  it('workspace admin can create an outgoing webhook (201)', async () => {
    // Literal public IP keeps this hermetic — net.isIP short-circuits the SSRF
    // guard before any dns.lookup, so the test needs no network.
    const res = await as(A.token, A.wsId, '/api/v1/integrations/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `hook-${RUN}`, url: 'https://1.1.1.1/hook', events: ['ticket.created'] }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects an outgoing webhook URL that resolves to an internal address (400)', async () => {
    const res = await as(A.token, A.wsId, '/api/v1/integrations/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `ssrf-${RUN}`, url: 'http://169.254.169.254/latest/meta-data/', events: ['ticket.created'] }),
    });
    expect(res.status).toBe(400);
  });
});
