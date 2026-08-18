// DELETE /api/v1/customers/:id (soft delete, blocked by ticket history) and
// the customer-notes API (list/create member-level, delete behind can_delete,
// audited, workspace-isolated).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('customer delete + notes (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const realFetch = globalThis.fetch;

  const RUN = Date.now();
  const admin = { email: `cdn-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `cdn-agent-${RUN}@t.test` } as Record<string, string>;
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
  async function mkCustomer(ws: string, tag: string, email?: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, last_name, email)
      values (${ws}, ${'M-' + tag + '-' + RUN}, 'C', 'D', ${email ?? `cdn-${tag}-${RUN}@cust.test`})
      returning id
    `;
    return row.id;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: wsA }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'cdn-a-' + RUN}, ${'cdn-a-' + RUN}) as provision_brand`;
    const [{ provision_brand: wsB }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'cdn-b-' + RUN}, ${'cdn-b-' + RUN}) as provision_brand`;
    ctx.wsA = wsA; ctx.wsB = wsB;

    const [adminRoleA] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsA} and is_admin = true limit 1`;
    const [plainRoleA] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsA} and name = 'Read Only' limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsA}, ${admin.userId}, ${adminRoleA.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsA}, ${agent.userId}, ${plainRoleA.id}, true)`;
    const [adminRoleB] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsB} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsB}, ${admin.userId}, ${adminRoleB.id}, true)`;
  }, 30000);

  beforeEach(() => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await sql`delete from workspaces where id in (${ctx.wsA}, ${ctx.wsB})`;
    await sql`delete from users where id in (${admin.userId}, ${agent.userId})`;
  }, 15000);

  // ─── Notes ────────────────────────────────────────────────────────────────

  it('any member creates a note; the workspace list returns it with the author name', async () => {
    ctx.noteCust = await mkCustomer(ctx.wsA, 'notes');
    const created = await as(agent.token, ctx.wsA, `/api/v1/customers/${ctx.noteCust}/notes`, {
      method: 'POST', body: JSON.stringify({ text: 'VIP — prefers phone contact' }),
    });
    expect(created.status).toBe(201);
    const { note } = await created.json() as any;
    expect(note.author_name).toBe(agent.email);   // signUp uses email as name
    ctx.noteId = note.id;

    const list = await as(admin.token, ctx.wsA, '/api/v1/customers/notes');
    const { notes } = await list.json() as any;
    expect(notes.some((n: any) => n.id === ctx.noteId)).toBe(true);

    // Isolation: workspace B's list never sees it.
    const listB = await as(admin.token, ctx.wsB, '/api/v1/customers/notes');
    expect(((await listB.json()) as any).notes.some((n: any) => n.id === ctx.noteId)).toBe(false);
  });

  it('rejects an empty note body', async () => {
    const res = await as(agent.token, ctx.wsA, `/api/v1/customers/${ctx.noteCust}/notes`, {
      method: 'POST', body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('note delete: 403 for a plain member, 404 cross-workspace, 204 + audit for permitted', async () => {
    const denied = await as(agent.token, ctx.wsA, `/api/v1/customers/${ctx.noteCust}/notes/${ctx.noteId}`, { method: 'DELETE' });
    expect(denied.status).toBe(403);

    const cross = await as(admin.token, ctx.wsB, `/api/v1/customers/${ctx.noteCust}/notes/${ctx.noteId}`, { method: 'DELETE' });
    expect(cross.status).toBe(404);

    const ok = await as(admin.token, ctx.wsA, `/api/v1/customers/${ctx.noteCust}/notes/${ctx.noteId}`, { method: 'DELETE' });
    expect(ok.status).toBe(204);
    const [audit] = await sql<{ metadata: any }[]>`
      select metadata from audit_events
      where workspace_id = ${ctx.wsA} and action = 'customer_note.deleted' and target_id = ${ctx.noteId}
    `;
    expect(audit).toBeDefined();
    expect(audit.metadata.text_preview).toContain('VIP');
  });

  // ─── Customer delete ──────────────────────────────────────────────────────

  it('refuses while the customer has live tickets (has_tickets), deletes after they are gone', async () => {
    const cust = await mkCustomer(ctx.wsA, 'del1');
    const { nextDisplayId } = await import('./lib/display-id.js');
    const displayId = await nextDisplayId(sql, ctx.wsA, 'ticket');
    const [ticket] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ctx.wsA}, ${displayId}, 'their ticket', ${cust}, 'open', 'normal')
      returning id
    `;

    const blocked = await as(admin.token, ctx.wsA, `/api/v1/customers/${cust}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as any).code).toBe('has_tickets');

    await as(admin.token, ctx.wsA, `/api/v1/tickets/${ticket.id}`, { method: 'DELETE' });
    const ok = await as(admin.token, ctx.wsA, `/api/v1/customers/${cust}`, { method: 'DELETE' });
    expect(ok.status).toBe(204);
    const [audit] = await sql`
      select 1 from audit_events
      where workspace_id = ${ctx.wsA} and action = 'customer.deleted' and target_id = ${cust}
    `;
    expect(audit).toBeDefined();
    ctx.deletedCust = cust;
  });

  it('frees the email for reuse (partial unique index) and 403s a plain member', async () => {
    // Same email as the customer just soft-deleted — must not 23505.
    const [row] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, last_name, email)
      values (${ctx.wsA}, ${'M-reuse-' + RUN}, 'R', 'E', ${`cdn-del1-${RUN}@cust.test`})
      returning id
    `;
    expect(row.id).toBeDefined();

    const denied = await as(agent.token, ctx.wsA, `/api/v1/customers/${row.id}`, { method: 'DELETE' });
    expect(denied.status).toBe(403);
  });

  it('cross-workspace customer delete is a 404', async () => {
    const cust = await mkCustomer(ctx.wsA, 'iso');
    const res = await as(admin.token, ctx.wsB, `/api/v1/customers/${cust}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
