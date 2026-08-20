// GDPR data-subject export — DB-backed integration test (RUN_DB_TESTS, same
// harness as tenant-isolation / gdpr-erasure). Seeds a customer with data across
// every surface, calls GET /api/v1/customers/:id/export, asserts the bundle is
// complete + admin-gated.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('GDPR export (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const slug = `exp-${RUN}`;
  const admin = { email: `exp-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `exp-agent-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({
      body: { email, password: 'password-12345', name: email },
      returnHeaders: true,
    });
    return { id: r.response.user.id, token: r.response.token };
  }

  function as(token: string | null, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', ctx.wsId);
    return app.request(path, { ...init, headers });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${slug}, ${slug}) as provision_brand
    `;
    ctx.wsId = wsId;

    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and is_admin = true limit 1`;
    const [roRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and coalesce(is_admin,false) = false limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${agent.userId}, ${roRole.id}, true)`;

    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, last_name, email, mobile, kyc_status, jurisdiction)
      values (${wsId}, ${'M-' + slug}, 'Jane', 'Doe', ${'jane-' + slug + '@player.test'}, '+15551234', 'verified', 'MT')
      returning id
    `;
    ctx.customerId = cust.id;

    const [tk] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${wsId}, ${'TK-' + slug}, 'Withdrawal help', ${cust.id}, 'open', 'normal')
      returning id
    `;
    ctx.ticketId = tk.id;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body) values (${wsId}, ${tk.id}, 'customer', 'Jane Doe', 'Where is my withdrawal?')`;
    await sql`insert into customer_notes (workspace_id, customer_id, text) values (${wsId}, ${cust.id}, 'Patient VIP')`;

    const [ch] = await sql<{ id: string }[]>`insert into channels (workspace_id, display_id, name, type) values (${wsId}, ${'CH-' + slug}, 'Inbox', 'email') returning id`;
    await sql`
      insert into inbox_messages (workspace_id, channel_id, from_name, from_email, subject, body, received_at, converted_ticket_id)
      values (${wsId}, ${ch.id}, 'Jane Doe', ${'jane-' + slug + '@player.test'}, 'Withdrawal', 'help please', now(), ${tk.id})
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    if (ctx.wsId) await sql`delete from workspaces where id = ${ctx.wsId}`;
    const ids = [admin.userId, agent.userId].filter(Boolean);
    if (ids.length) await sql`delete from users where id in ${sql(ids)}`;
  });

  it('non-admin members are refused (403)', async () => {
    const res = await as(agent.token, `/api/v1/customers/${ctx.customerId}/export`);
    expect(res.status).toBe(403);
  });

  it('404s an unknown customer id', async () => {
    const res = await as(admin.token, `/api/v1/customers/00000000-0000-0000-0000-000000000000/export`);
    expect(res.status).toBe(404);
  });

  it('returns the full personal-data bundle as a download', async () => {
    const res = await as(admin.token, `/api/v1/customers/${ctx.customerId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const body: any = await res.json();

    expect(body.customer.email).toBe(`jane-${slug}@player.test`);
    expect(body.customer.first_name).toBe('Jane');
    expect(body.customer.display_id).toBe('M-' + slug);
    expect(body.customer.id).toBeUndefined(); // internal uuid stripped

    expect(body.notes.length).toBe(1);
    expect(body.notes[0].text).toBe('Patient VIP');

    expect(body.tickets.length).toBe(1);
    expect(body.tickets[0].subject).toBe('Withdrawal help');
    expect(body.tickets[0].messages.length).toBe(1);
    expect(body.tickets[0].messages[0].body).toBe('Where is my withdrawal?');

    expect(body.inbox_messages.length).toBeGreaterThanOrEqual(1);
    expect(body.inbox_messages[0].from_email).toBe(`jane-${slug}@player.test`);

    expect(typeof body.exported_at).toBe('string');
    expect(body.workspace.slug).toBe(slug);     // provenance, not internal uuid
    expect((body as any).workspace_id).toBeUndefined();
  });

  it('returns 410 Gone once the customer has been erased', async () => {
    const erase = await as(admin.token, `/api/v1/customers/${ctx.customerId}/erase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(erase.status).toBe(200);
    const res = await as(admin.token, `/api/v1/customers/${ctx.customerId}/export`);
    expect(res.status).toBe(410);
  });
});
