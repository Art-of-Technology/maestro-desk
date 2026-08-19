// POST /api/v1/tickets — creation contract (Phase 3): display-id allocation,
// default-assignee + rules vs explicit assignee (rules skipped), category
// validation, the post-rules full-row response, and the API-compat
// initial_message behavior.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('ticket create (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const realFetch = globalThis.fetch;

  const RUN = Date.now();
  const admin = { email: `tc-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `tc-agent-${RUN}@t.test` } as Record<string, string>;
  const outsider = { email: `tc-out-${RUN}@t.test` } as Record<string, string>;
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
  function create(body: Record<string, unknown>) {
    return as(admin.token, ctx.ws, '/api/v1/tickets', { method: 'POST', body: JSON.stringify(body) });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug, uo] = await Promise.all([signUp(admin.email), signUp(agent.email), signUp(outsider.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;
    outsider.userId = uo.id;

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'tc-' + RUN}, ${'tc-' + RUN}) as provision_brand`;
    ctx.ws = ws;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    const [plainRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and name = 'Read Only' limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${agent.userId}, ${plainRole.id}, true)`;
    // outsider deliberately NOT a member.

    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, last_name, email)
      values (${ws}, ${'M-tc-' + RUN}, 'T', 'C', ${`tc-cust-${RUN}@cust.test`})
      returning id
    `;
    ctx.custId = cust.id;

    // An inactive category for the validation matrix.
    await sql`insert into ticket_categories (workspace_id, key, label, is_active) values (${ws}, 'Retired', 'Retired', false)`;
  }, 30000);

  beforeEach(() => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await sql`delete from workspaces where id = ${ctx.ws}`;
    await sql`delete from users where id in (${admin.userId}, ${agent.userId}, ${outsider.userId})`;
  }, 15000);

  it('creates with an allocated display id and returns the full post-rules row', async () => {
    const res = await create({ subject: 'first', customer_id: ctx.custId, category_key: 'Account' });
    expect(res.status).toBe(201);
    const { ticket } = await res.json() as any;
    // Full list-shape row, not the old two-column stub.
    expect(ticket.display_id).toMatch(/^TK-\d+$/);
    expect(ticket.subject).toBe('first');
    expect(ticket.customer_id).toBe(ctx.custId);
    expect(ticket.status_key).toBe('open');
    expect(ticket.priority_key).toBe('normal');
    expect(ticket.category_key).toBe('Account');
    expect(ticket.created_at).toBeDefined();
    expect(ticket.last_message_role).toBeNull();
    // No rules configured → default assignee is the creating agent.
    expect(ticket.assigned_user_id).toBe(admin.userId);
  });

  it('honors an explicit assignee and does NOT run assignment rules over it', async () => {
    // A rule that would grab everything for the admin — the explicit pick
    // must still win because the engine is skipped.
    await sql`
      insert into assign_rules (workspace_id, display_id, name, priority, status, conditions, assignment)
      values (${ctx.ws}, ${'AR-' + RUN}, 'grab-all', 1, 'active',
              ${sql.json({ priority: 'all', category: 'all', vip: 'all' })},
              ${sql.json({ mode: 'specific-agent', agent_user_id: admin.userId })})
    `;
    const res = await create({ subject: 'explicit', customer_id: ctx.custId, assigned_user_id: agent.userId });
    expect(res.status).toBe(201);
    const { ticket } = await res.json() as any;
    expect(ticket.assigned_user_id).toBe(agent.userId);

    // Without an explicit assignee the same rule DOES apply.
    const auto = await create({ subject: 'auto', customer_id: ctx.custId });
    const { ticket: autoT } = await auto.json() as any;
    expect(autoT.assigned_user_id).toBe(admin.userId);
    await sql`delete from assign_rules where workspace_id = ${ctx.ws}`;
  });

  it('rejects a non-member assignee (400)', async () => {
    const res = await create({ subject: 'bad assignee', customer_id: ctx.custId, assigned_user_id: outsider.userId });
    expect(res.status).toBe(400);
  });

  it('category matrix: valid ok · inactive 400 · unknown 400 · omitted ok (null)', async () => {
    expect((await create({ subject: 'c1', customer_id: ctx.custId, category_key: 'Payments' })).status).toBe(201);
    expect((await create({ subject: 'c2', customer_id: ctx.custId, category_key: 'Retired' })).status).toBe(400);
    expect((await create({ subject: 'c3', customer_id: ctx.custId, category_key: 'NoSuchKey' })).status).toBe(400);
    const omitted = await create({ subject: 'c4', customer_id: ctx.custId });
    expect(omitted.status).toBe(201);
    expect(((await omitted.json()) as any).ticket.category_key).toBeNull();
  });

  it('initial_message regression pin: role customer, author "API caller", not the last word on shape', async () => {
    const res = await create({ subject: 'with msg', customer_id: ctx.custId, initial_message: 'hello from the API' });
    expect(res.status).toBe(201);
    const { ticket } = await res.json() as any;
    const [msg] = await sql<{ role: string; author_label: string; author_user_id: string | null }[]>`
      select role, author_label, author_user_id from ticket_messages where ticket_id = ${ticket.id}
    `;
    expect(msg.role).toBe('customer');
    expect(msg.author_label).toBe('API caller');
    expect(msg.author_user_id).toBeNull();
    expect(ticket.last_message_role).toBe('customer');   // post-insert re-select sees it
  });

  it('player-lookup shape pin: ticket.display_id present in the envelope', async () => {
    const res = await create({ subject: 'shape', customer_id: ctx.custId });
    const body = await res.json() as any;
    expect(typeof body.ticket.display_id).toBe('string');   // startConversation reads exactly this
  });
});
