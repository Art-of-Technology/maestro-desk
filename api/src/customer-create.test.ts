import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('manual customer creation', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const users: { id: string; token: string }[] = [];
  const workspaces: string[] = [];
  const run = Date.now();
  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    for (let i = 0; i < 2; i++) {
      const r: any = await auth.api.signUpEmail({ body: { email: `create-${run}-${i}@t.test`, password: 'password-12345', name: 'Customer test' }, returnHeaders: true });
      users.push({ id: r.response.user.id, token: r.response.token });
      const [{ ws }] = await sql`select provision_brand(${'create-' + run + '-' + i}, ${'create-' + run + '-' + i}) as ws`;
      workspaces.push(ws);
    }
    for (const ws of workspaces) {
      const [admin] = await sql`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
      await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${users[0].id}, ${admin.id}, true)`;
    }
    const [role] = await sql`select id from roles where workspace_id = ${workspaces[0]} and name = 'Senior Agent' limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${workspaces[0]}, ${users[1].id}, ${role.id}, true)`;
  });
  afterAll(async () => {
    for (const ws of workspaces) await sql`delete from workspaces where id = ${ws}`;
    for (const user of users) await sql`delete from users where id = ${user.id}`;
  });
  function request(method: string, suffix = '', body?: object, user = 0, workspace = 0) {
    return app.request('/api/v1/customers' + suffix, { method,
      headers: { Authorization: `Bearer ${users[user].token}`, 'X-Workspace-Id': workspaces[workspace], 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  const create = (body: object, user = 0, workspace = 0) => request('POST', '', { first_name: 'Manual', last_name: 'Customer', ...body }, user, workspace);

  it('resolves email-only contacts without names or player identity, including concurrent saves', async () => {
    const replies = await Promise.all([request('POST', '/from-email', { email: ' New@Example.test ' }), request('POST', '/from-email', { email: 'new@example.test' })]);
    expect(replies.map(r => r.status)).toEqual([200, 200]);
    const [a, b] = await Promise.all(replies.map(r => r.json())) as any[];
    expect(a.customer.id).toBe(b.customer.id);
    expect(a.customer.first_name).toBe('');
    expect(a.customer.last_name).toBe('');
    expect(a.customer.maestro_user_id).toBeNull();
    expect(a.customer.consent).toBe(false);
    expect(a.customer.emails[0].value).toBe('new@example.test');
    const other: any = await (await request('POST', '/from-email', { email: 'new@example.test' }, 0, 1)).json();
    expect(other.customer.id).not.toBe(a.customer.id);
    expect((await request('POST', '/from-email', { email: 'new@example.test' }, 1, 1)).status).toBe(403);
    for (const body of [{ email: 'invalid' }, { email: 'new@example.test', consent: true }]) {
      expect((await request('POST', '/from-email', body)).status).toBe(400);
    }
  });

  it('reuses secondary addresses and permits only this contact’s live addresses as outbound recipients', async () => {
    const { customer } = await (await create({ email: 'primary-outbound@example.test' })).json() as any;
    expect((await request('POST', `/${customer.id}/contacts`, { kind: 'email', value: 'secondary-outbound@example.test' })).status).toBe(201);
    const resolved: any = await (await request('POST', '/from-email', { email: 'SECONDARY-outbound@example.test' })).json();
    expect(resolved.customer.id).toBe(customer.id);
    expect(resolved.customer.email).toBe('primary-outbound@example.test');
    const response = await app.request('/api/v1/tickets', { method: 'POST',
      headers: { Authorization: `Bearer ${users[0].token}`, 'X-Workspace-Id': workspaces[0], 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: customer.id, subject: 'Email only' }) });
    expect(response.status).toBe(201);
    const { ticket } = await response.json() as any;
    const { ticketReplyRecipients } = await import('./lib/email-recipients.js');
    const input = { source_message_id: null, mode: 'reply' as const, to: ['secondary-outbound@example.test'], cc: [] };
    expect((await ticketReplyRecipients(workspaces[0], ticket.id, input)).to).toEqual(input.to);
    await expect(ticketReplyRecipients(workspaces[0], ticket.id, { ...input, to: ['foreign@example.test'] })).rejects.toThrow('recipient changed');
    await sql`update customer_contacts set deleted_at=now() where customer_id=${customer.id} and value='secondary-outbound@example.test'`;
    await expect(ticketReplyRecipients(workspaces[0], ticket.id, input)).rejects.toThrow('recipient changed');
  });

  it('persists an agent-created profile with primary contacts and no invented identity or consent', async () => {
    const r = await create({ email: ' Manual@Example.test ', jurisdiction: 'UK' }, 1);
    expect(r.status).toBe(201);
    const { customer: c } = await r.json() as any;
    expect(c.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(c.email).toBe('manual@example.test');
    expect(c.emails).toHaveLength(1);
    expect(c.emails[0].is_primary).toBe(true);
    expect(c.consent).toBe(false);
    expect(c.maestro_user_id).toBeNull();
    const listed = await (await request('GET')).json() as any;
    expect(listed.customers.find((x: any) => x.id === c.id).display_id).toBe(c.display_id);
    const other = await create({ email: 'manual@example.test' }, 0, 1);
    expect(other.status).toBe(201);
    expect((await request('GET', '', undefined, 1, 1)).status).toBe(403);
  });
  it('rejects invalid data and mass-assigned workspace, consent and player identity', async () => {
    for (const body of [{ email: 'bad' }, { first_name: ' ' }, { workspace_id: workspaces[1] }, { consent: true }, { maestro_user_id: 'invented' }]) {
      expect((await create(body)).status).toBe(400);
    }
  });
  it('allows profiles without email; merge and unmerge preserve their identities', async () => {
    const { customer: a } = await (await create({ email: null })).json() as any;
    const { customer: b } = await (await create({})).json() as any;
    expect(a.id).not.toBe(b.id);
    expect(a.emails).toHaveLength(0);
    expect((await request('POST', `/${a.id}/merge`, { into_id: b.id })).status).toBe(200);
    expect((await request('POST', `/${a.id}/unmerge`, {})).status).toBe(200);
    const rows = await sql`select id, merged_into_customer_id from customers where id in (${a.id}, ${b.id})`;
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.merged_into_customer_id === null)).toBe(true);
  });
  it('rejects a secondary-address duplicate and concurrent primary duplicates without partial rows', async () => {
    const { customer: owner } = await (await create({ email: 'owner@example.test' })).json() as any;
    expect((await request('POST', `/${owner.id}/contacts`, { kind: 'email', value: 'secondary@example.test' })).status).toBe(201);
    expect((await create({ email: 'SECONDARY@example.test' })).status).toBe(409);
    const replies = await Promise.all([create({ email: 'race@example.test' }), create({ email: 'race@example.test' })]);
    expect(replies.map(r => r.status).sort()).toEqual([201, 409]);
    const rows = await sql`select id from customers where workspace_id = ${workspaces[0]} and email = 'race@example.test'`;
    expect(rows).toHaveLength(1);
    const contacts = await sql`select id from customer_contacts where workspace_id = ${workspaces[0]} and value = 'race@example.test' and deleted_at is null`;
    expect(contacts).toHaveLength(1);
  });
});
