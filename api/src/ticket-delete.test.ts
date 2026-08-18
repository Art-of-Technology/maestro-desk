// DELETE /api/v1/tickets/:id — soft delete gated by can_delete, with the
// blank-ticket exception (any member may delete a ticket whose only messages
// are 'system' rows), merge-primary protection, sync tombstones, and audit.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('ticket delete (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const realFetch = globalThis.fetch;

  const RUN = Date.now();
  const admin = { email: `td-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `td-agent-${RUN}@t.test` } as Record<string, string>;
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
  async function mkCustomer(ws: string, tag: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, last_name, email)
      values (${ws}, ${'M-' + tag + '-' + RUN}, 'T', 'D', ${`td-${tag}-${RUN}@cust.test`})
      returning id
    `;
    return row.id;
  }
  async function mkTicket(ws: string, customerId: string, subject: string): Promise<{ id: string; display_id: string }> {
    const { nextDisplayId } = await import('./lib/display-id.js');
    const displayId = await nextDisplayId(sql, ws, 'ticket');
    const [row] = await sql<{ id: string; display_id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ws}, ${displayId}, ${subject}, ${customerId}, 'open', 'normal')
      returning id, display_id
    `;
    return row;
  }
  async function addMsg(ws: string, ticketId: string, role: string, body = 'hello') {
    await sql`
      insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
      values (${ws}, ${ticketId}, ${role}, 'Test', ${body})
    `;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: wsA }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'td-a-' + RUN}, ${'td-a-' + RUN}) as provision_brand`;
    const [{ provision_brand: wsB }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'td-b-' + RUN}, ${'td-b-' + RUN}) as provision_brand`;
    ctx.wsA = wsA; ctx.wsB = wsB;

    const [adminRoleA] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsA} and is_admin = true limit 1`;
    const [plainRoleA] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsA} and name = 'Read Only' limit 1`;
    ctx.plainRoleId = plainRoleA.id;
    const [cleaner] = await sql<{ id: string }[]>`
      insert into roles (workspace_id, name, is_admin, can_delete)
      values (${wsA}, ${'Cleaner-' + RUN}, false, true) returning id
    `;
    ctx.cleanerRoleId = cleaner.id;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsA}, ${admin.userId}, ${adminRoleA.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsA}, ${agent.userId}, ${plainRoleA.id}, true)`;
    // Admin is a member of B too, so the isolation check exercises a real membership.
    const [adminRoleB] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsB} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsB}, ${admin.userId}, ${adminRoleB.id}, true)`;

    ctx.custA = await mkCustomer(ctx.wsA, 'a');
  }, 30000);

  beforeEach(() => {
    // Ticket mutations fan out to Slack/webhooks/Pubby — never hit the network.
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await sql`delete from workspaces where id in (${ctx.wsA}, ${ctx.wsB})`;
    await sql`delete from users where id in (${admin.userId}, ${agent.userId})`;
  }, 15000);

  it('any member deletes a messageless ticket (blank rule)', async () => {
    const t = await mkTicket(ctx.wsA, ctx.custA, 'blank-1');
    const res = await as(agent.token, ctx.wsA, `/api/v1/tickets/${t.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [row] = await sql<{ deleted_at: string | null }[]>`select deleted_at from tickets where id = ${t.id}`;
    expect(row.deleted_at).not.toBeNull();
  });

  it('any member deletes a system-only ticket (bookkeeping rows do not count)', async () => {
    const t = await mkTicket(ctx.wsA, ctx.custA, 'blank-2');
    await addMsg(ctx.wsA, t.id, 'system', '── marker ──');
    const res = await as(agent.token, ctx.wsA, `/api/v1/tickets/${t.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('a plain member is blocked on non-blank tickets (customer message, or a note)', async () => {
    const t1 = await mkTicket(ctx.wsA, ctx.custA, 'real-1');
    await addMsg(ctx.wsA, t1.id, 'customer');
    expect((await as(agent.token, ctx.wsA, `/api/v1/tickets/${t1.id}`, { method: 'DELETE' })).status).toBe(403);

    const t2 = await mkTicket(ctx.wsA, ctx.custA, 'real-2');
    await addMsg(ctx.wsA, t2.id, 'note', 'internal note');
    expect((await as(agent.token, ctx.wsA, `/api/v1/tickets/${t2.id}`, { method: 'DELETE' })).status).toBe(403);
    ctx.notedTicketId = t2.id;
  });

  it('an admin deletes a non-blank ticket, and the audit row records blank=false', async () => {
    const res = await as(admin.token, ctx.wsA, `/api/v1/tickets/${ctx.notedTicketId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [audit] = await sql<{ metadata: any }[]>`
      select metadata from audit_events
      where workspace_id = ${ctx.wsA} and action = 'ticket.deleted' and target_id = ${ctx.notedTicketId}
    `;
    expect(audit).toBeDefined();
    expect(audit.metadata.blank).toBe(false);
  });

  it('a non-admin role with can_delete deletes a non-blank ticket', async () => {
    const t = await mkTicket(ctx.wsA, ctx.custA, 'real-3');
    await addMsg(ctx.wsA, t.id, 'customer');
    await sql`update workspace_members set role_id = ${ctx.cleanerRoleId} where workspace_id = ${ctx.wsA} and user_id = ${agent.userId}`;
    expect((await as(agent.token, ctx.wsA, `/api/v1/tickets/${t.id}`, { method: 'DELETE' })).status).toBe(204);
    await sql`update workspace_members set role_id = ${ctx.plainRoleId} where workspace_id = ${ctx.wsA} and user_id = ${agent.userId}`;
  });

  it('a deleted ticket rides /tickets/sync as a tombstone', async () => {
    const t = await mkTicket(ctx.wsA, ctx.custA, 'sync-1');
    // Cursor from before the delete, using the composite shape.
    const cursor = `${new Date(Date.now() - 1000).toISOString()}|`;
    await as(admin.token, ctx.wsA, `/api/v1/tickets/${t.id}`, { method: 'DELETE' });
    const res = await as(admin.token, ctx.wsA, `/api/v1/tickets/sync?cursor=${encodeURIComponent(cursor)}`);
    const { tickets } = await res.json() as any;
    const tomb = tickets.find((x: any) => x.id === t.id);
    expect(tomb).toBeDefined();
    expect(tomb.deleted_at).not.toBeNull();
    expect(tomb.subject).toBeUndefined();   // tombstones are slimmed
  });

  it('a merge primary with live duplicates refuses deletion; a merged source deletes fine', async () => {
    const src = await mkTicket(ctx.wsA, ctx.custA, 'merge-src');
    const pri = await mkTicket(ctx.wsA, ctx.custA, 'merge-pri');
    const merged = await as(admin.token, ctx.wsA, `/api/v1/tickets/${src.id}/merge`, {
      method: 'POST', body: JSON.stringify({ into_id: pri.id }),
    });
    expect(merged.status).toBe(200);

    const blocked = await as(admin.token, ctx.wsA, `/api/v1/tickets/${pri.id}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as any).code).toBe('has_merged_children');

    // The merged source itself may be deleted (its messages already live on
    // the primary) — after which the primary deletes too.
    expect((await as(admin.token, ctx.wsA, `/api/v1/tickets/${src.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await as(admin.token, ctx.wsA, `/api/v1/tickets/${pri.id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('cross-workspace delete is a 404, even for an admin of the other workspace', async () => {
    const t = await mkTicket(ctx.wsA, ctx.custA, 'iso-1');
    const res = await as(admin.token, ctx.wsB, `/api/v1/tickets/${t.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
