import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('automatic customer intake assignment (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let inbound: typeof import('./lib/inbound-email.js').processInboundEmail;
  let workspaceId: string, otherWorkspaceId: string, userId: string, otherAgentId: string, token: string;
  const run = crypto.randomUUID();
  const slug = `intake-${run}`;
  const clientIp = `2001:db8:${run.replace(/-/g, '').slice(0, 24).match(/.{4}/g)!.join(':')}`;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    app = (await import('./index.js')).default;
    inbound = (await import('./lib/inbound-email.js')).processInboundEmail;
    const { auth } = await import('./lib/auth.js');
    const agent = await auth.api.signUpEmail({ body: { email: `intake-agent-${run}@t.test`, password: 'password-12345', name: 'Intake agent' } });
    userId = agent.user.id;
    token = agent.token!;
    const other = await auth.api.signUpEmail({ body: { email: `intake-other-${run}@t.test`, password: 'password-12345', name: 'Other agent' } });
    otherAgentId = other.user.id;
    const [ws] = await sql`select provision_brand(${slug}, ${slug}) as id`;
    workspaceId = ws.id;
    const [ws2] = await sql`select provision_brand('Other', ${'intake-other-' + run}) as id`;
    otherWorkspaceId = ws2.id;
    const [role] = await sql`select id from roles where workspace_id = ${workspaceId} and is_admin = true limit 1`;
    for (const id of [userId, otherAgentId]) {
      await sql`insert into workspace_members (workspace_id, user_id, role_id, active)
        values (${workspaceId}, ${id}, ${role.id}, true)`;
    }
    await sql`insert into assign_rules (workspace_id, display_id, name, priority, conditions, assignment)
      values (${workspaceId}, 'INTAKE-RULE', 'Default intake', 1, '{}'::jsonb,
        ${sql.json({ mode: 'specific-agent', agent_user_id: userId })})`;
    await sql`insert into channels (workspace_id, display_id, name, type, address, default_priority_key, default_category_key)
      values (${workspaceId}, 'INTAKE-CHANNEL', 'Complaints', 'email', ${`support@${slug}.test`}, 'high', 'Complaints')`;
  }, 30000);

  beforeEach(async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await sql`update workspace_members set ooo_from = null, ooo_to = null where workspace_id = ${workspaceId}`;
    await sql`update assign_rules set status = 'active' where workspace_id = ${workspaceId}`;
  });
  afterEach(() => { globalThis.fetch = realFetch; });
  afterAll(async () => {
    if (workspaceId) await sql`delete from workspaces where id = ${workspaceId}`;
    if (otherWorkspaceId) await sql`delete from workspaces where id = ${otherWorkspaceId}`;
    if (userId) await sql`delete from users where id = ${userId}`;
    if (otherAgentId) await sql`delete from users where id = ${otherAgentId}`;
    await sql`delete from rate_limit_hits where bucket in (${'portal-ticket:' + clientIp}, ${'portal-reply:' + clientIp})`;
  });

  const payload = (inReplyTo?: string) => {
    const id = crypto.randomUUID();
    return {
      MessageID: id, From: `customer-${run}@cust.test`, FromFull: { Email: `customer-${run}@cust.test`, Name: 'Customer' },
      ToFull: [{ Email: `support@${slug}.test` }], Subject: 'Intake assignment test', TextBody: 'Please help with my account', HtmlBody: '',
      Headers: [{ Name: 'Message-Id', Value: `<${id}@cust.test>` }, ...(inReplyTo ? [{ Name: 'In-Reply-To', Value: inReplyTo }] : [])],
    } as any;
  };
  async function create(source: 'email' | 'portal', ws = workspaceId) {
    let id: string;
    if (source === 'email') {
      id = (await inbound({ workspaceId: ws, payload: payload() })).ticket_id;
    } else {
      const res = await app.request(`/api/v1/public/${ws === workspaceId ? slug : 'intake-other-' + run}/tickets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp },
        body: JSON.stringify({ name: 'Customer', email: `customer-${run}@cust.test`, subject: 'Intake assignment test', body: 'Please help with my account' }),
      });
      expect(res.status).toBe(201);
      id = (await res.json() as any).ticket.id;
    }
    const [ticket] = await sql`select * from tickets where id = ${id} and workspace_id = ${ws}`;
    return ticket;
  }

  for (const source of ['email', 'portal'] as const) {
    it(`${source}: assigns the new ticket without changing its priority/category`, async () => {
      const ticket = await create(source);
      expect(ticket.assigned_user_id).toBe(userId);
      expect(ticket.priority_key).toBe(source === 'email' ? 'high' : 'normal');
      expect(ticket.category_key).toBe(source === 'email' ? 'Complaints' : null);
    });
    it(`${source}: leaves the ticket unassigned when the chosen agent is absent or no rule matches`, async () => {
      await sql`update workspace_members set ooo_from = '2000-01-01' where workspace_id = ${workspaceId} and user_id = ${userId}`;
      expect((await create(source)).assigned_user_id).toBeNull();
      await sql`update workspace_members set ooo_from = null where workspace_id = ${workspaceId} and user_id = ${userId}`;
      await sql`update assign_rules set status = 'inactive' where workspace_id = ${workspaceId}`;
      expect((await create(source)).assigned_user_id).toBeNull();
    });
    it(`${source}: does not apply another workspace's rule`, async () => {
      expect((await create(source, otherWorkspaceId)).assigned_user_id).toBeNull();
    });
    it(`${source}: keeps the accepted ticket and message if assignment fails`, async () => {
      const engine = await import('./lib/assign-rules-engine.js');
      const failure = spyOn(engine, 'applyAssignmentRules').mockRejectedValue(new Error('Test rule failure'));
      try {
        const ticket = await create(source);
        expect(ticket.assigned_user_id).toBeNull();
        const messages = await sql`select body from ticket_messages where ticket_id = ${ticket.id} and role = 'customer'`;
        expect(messages).toHaveLength(1);
        expect(messages[0].body).toBe('Please help with my account');
      } finally { failure.mockRestore(); }
    });
    it(`${source}: leaves the existing owner unchanged on a customer reply`, async () => {
      const ticket = await create(source);
      await sql`update tickets set assigned_user_id = ${otherAgentId} where id = ${ticket.id}`;
      if (source === 'email') {
        const externalId = `<agent-${crypto.randomUUID()}@brand.test>`;
        await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
          values (${workspaceId}, ${ticket.id}, 'agent', 'Agent', 'Answer', ${externalId})`;
        expect((await inbound({ workspaceId, payload: payload(externalId) })).ticket_id).toBe(ticket.id);
      } else {
        const portal = await import('./lib/portal-auth.js');
        const { token: magic } = await portal.createMagicLink({ workspaceId, customerId: ticket.customer_id });
        const session = await portal.verifyMagicLink({ workspaceId, token: magic });
        if (!session) throw new Error('Portal session failed');
        const res = await app.request(`/api/v1/public/${slug}/customer/tickets/${ticket.display_id}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${session.sessionToken}`, 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp },
          body: JSON.stringify({ body: 'Follow-up' }),
        });
        expect(res.status).toBe(201);
      }
      const [after] = await sql`select assigned_user_id from tickets where id = ${ticket.id}`;
      expect(after.assigned_user_id).toBe(otherAgentId);
    });
  }

  it('keeps an explicit agent choice when an agent creates a ticket', async () => {
    const customer = (await create('email')).customer_id;
    const res = await app.request('/api/v1/tickets', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspaceId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Explicit choice', customer_id: customer, assigned_user_id: otherAgentId }),
    });
    expect(res.status).toBe(201);
    expect((await res.json() as any).ticket.assigned_user_id).toBe(otherAgentId);
  });
});
