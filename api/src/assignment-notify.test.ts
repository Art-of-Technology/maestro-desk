import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('assignment email notifications (isolated database)', () => {
  let app: typeof import('./index.js').default, sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let admin: { id: string; token: string }, agent: typeof admin, outsider: typeof admin;
  let ws: string, otherWs: string, role: string, customer: string, ticket: string;
  const stamp = Date.now(), mails: any[] = [], realFetch = globalThis.fetch;
  let failProvider = false;
  const request = (user: typeof admin, path: string, method = 'GET', body?: unknown) => app.request('/api/v1/' + path, {
    method, headers: { Authorization: 'Bearer ' + user.token, 'X-Workspace-Id': ws, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const assign = (id: string | null, user = admin) => request(user, `tickets/${ticket}`, 'PATCH', { assigned_user_id: id });
  const notify = async (overrides = {}) => {
    const { notifyAssignedAgent } = await import('./lib/assignment-notify.js');
    await notifyAssignedAgent({ workspaceId: ws, ticketId: ticket, assigneeId: agent.id, previousAssigneeId: null, actorId: admin.id, ...overrides });
  };
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    async function signup(name: string) {
      const result: any = await auth.api.signUpEmail({ body: { email: `assignment-${name}-${stamp}@test.test`, name, password: 'synthetic-password-12345' }, returnHeaders: true });
      return { id: result.response.user.id, token: result.response.token };
    }
    admin = await signup('admin'); agent = await signup('agent'); outsider = await signup('outsider');
    [{ id: ws }] = await sql`select provision_brand(${'Assignment ' + stamp}, ${'assignment-' + stamp}) as id`;
    [{ id: otherWs }] = await sql`select provision_brand(${'Other ' + stamp}, ${'assignment-other-' + stamp}) as id`;
    const [adminRole] = await sql`select id from roles where workspace_id=${ws} and is_admin limit 1`;
    [{ id: role }] = await sql`select id from roles where workspace_id=${ws} and name='Senior Agent'`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${ws},${admin.id},${adminRole.id},true),(${ws},${agent.id},${role},true)`;
    const [otherRole] = await sql`select id from roles where workspace_id=${otherWs} and is_admin limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${otherWs},${outsider.id},${otherRole.id},true)`;
    [{ id: customer }] = await sql`insert into customers(workspace_id,display_id,first_name) values(${ws},'ASG-C','Synthetic') returning id`;
  }, 30000);
  beforeEach(async () => {
    mails.length = 0; failProvider = false;
    globalThis.fetch = (async (url: any, options: any) => {
      if (!String(url).includes('api.postmarkapp.com/email')) throw new Error('Unexpected external request blocked');
      mails.push(JSON.parse(options.body));
      if (failProvider) throw new Error('Synthetic provider unavailable');
      return Response.json({ ErrorCode: 0, MessageID: crypto.randomUUID(), SubmittedAt: new Date().toISOString() });
    }) as typeof fetch;
    await sql`update users set assignment_email_enabled=true where id=${agent.id}`;
    await sql`update workspace_members set active=true where workspace_id=${ws} and user_id=${agent.id}`;
    await sql`update roles set permissions=null where id=${role}`;
    await sql`update assign_rules set status='inactive' where workspace_id=${ws}`;
    [{ id: ticket }] = await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
      values(${ws},${'ASG-' + crypto.randomUUID()},'Synthetic <subject>',${customer},'open','normal') returning id`;
  });
  afterEach(() => { globalThis.fetch = realFetch; });
  afterAll(async () => {
    if (!sql) return;
    if (ws) await sql`delete from workspaces where id=${ws}`;
    if (otherWs) await sql`delete from workspaces where id=${otherWs}`;
    if (admin && agent && outsider) await sql`delete from users where id in (${admin.id},${agent.id},${outsider.id})`;
  });
  it('emails the new assignee with an escaped branded subject and a working ticket link', async () => {
    expect((await assign(agent.id)).status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].To).toBe(`assignment-agent-${stamp}@test.test`);
    expect(mails[0].TextBody).toContain('Synthetic <subject>');
    expect(mails[0].TextBody).toContain(`/#/w/assignment-${stamp}/tickets/ASG-`);
    expect(mails[0].TextBody).toContain('Settings → Notifications');
    expect(mails[0].HtmlBody).toContain('Synthetic &lt;subject&gt;');
    expect(mails[0].HtmlBody).toContain('Open ticket');
  });
  it('does not duplicate concurrent saves, unchanged assignments, self-assignment or unassignment', async () => {
    const results = await Promise.all([assign(agent.id), assign(agent.id)]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(mails).toHaveLength(1);
    mails.length = 0;
    expect((await assign(agent.id)).status).toBe(200);
    expect((await assign(null)).status).toBe(200);
    expect((await assign(admin.id)).status).toBe(200);
    expect(mails).toHaveLength(0);
  });
  it('supports recipients restricted to viewing their assigned tickets', async () => {
    await sql`update roles set permissions=${sql.json({ 'tickets.view_assigned': true })} where id=${role}`;
    expect((await assign(agent.id)).status).toBe(200);
    expect(mails).toHaveLength(1);
  });
  it('emails once for an explicit assignee on ticket creation', async () => {
    const response = await request(admin, 'tickets', 'POST', { subject: 'Synthetic create', customer_id: customer, assigned_user_id: agent.id });
    expect(response.status).toBe(201);
    expect(mails).toHaveLength(1);
  });
  it('emails once for rule assignment, including system intake, and skips an unchanged rule result', async () => {
    await sql`insert into assign_rules(workspace_id,display_id,name,priority,conditions,assignment)
      values(${ws},${'ASG-R-' + crypto.randomUUID()},'Synthetic rule',1,'{}'::jsonb,${sql.json({ mode: 'specific-agent', agent_user_id: agent.id })})`;
    expect((await request(admin, 'tickets', 'POST', { subject: 'Synthetic rule create', customer_id: customer })).status).toBe(201);
    expect(mails).toHaveLength(1);
    mails.length = 0;
    expect((await request(agent, 'tickets', 'POST', { subject: 'Synthetic self rule', customer_id: customer })).status).toBe(201);
    expect(mails).toHaveLength(0);
    const { applyAssignmentRules } = await import('./lib/assign-rules-engine.js');
    await applyAssignmentRules({ workspaceId: ws, ticketId: ticket });
    await applyAssignmentRules({ workspaceId: ws, ticketId: ticket });
    expect(mails).toHaveLength(1);
  });
  it('saves only the signed-in user preference and honours opt-out', async () => {
    const initial = await request(agent, 'me');
    expect((await initial.json() as any).user.assignment_email_enabled).toBe(true);
    expect((await request(agent, 'me', 'PATCH', { assignment_email_enabled: false })).status).toBe(200);
    expect((await request(agent, 'me', 'PATCH', { assignment_email_enabled: 'false' })).status).toBe(400);
    expect((await request(agent, 'me', 'PATCH', { assignment_email_enabled: false, user_id: admin.id })).status).toBe(400);
    const adminPreference = await request(admin, 'me');
    expect((await adminPreference.json() as any).user.assignment_email_enabled).toBe(true);
    expect((await assign(agent.id)).status).toBe(200);
    expect((await request(admin, 'tickets', 'POST', { subject: 'Synthetic opted-out create', customer_id: customer, assigned_user_id: agent.id })).status).toBe(201);
    expect(mails).toHaveLength(0);
    expect((await request(agent, 'me', 'PATCH', { assignment_email_enabled: true })).status).toBe(200);
    await assign(null); await assign(agent.id);
    expect(mails).toHaveLength(1);
  });
  it('skips inactive, out-of-brand, inaccessible, stale and unavailable recipients/tickets', async () => {
    await sql`update tickets set assigned_user_id=${agent.id} where id=${ticket}`;
    await sql`update workspace_members set active=false where workspace_id=${ws} and user_id=${agent.id}`;
    await notify();
    await sql`update workspace_members set active=true where workspace_id=${ws} and user_id=${agent.id}`;
    await sql`update roles set permissions='{}'::jsonb where id=${role}`;
    await notify();
    await sql`update roles set permissions=null where id=${role}`;
    const [foreignRole] = await sql`select id from roles where workspace_id=${otherWs} limit 1`;
    await sql`update workspace_members set role_id=${foreignRole.id} where workspace_id=${ws} and user_id=${agent.id}`;
    await notify();
    await sql`update workspace_members set role_id=${role} where workspace_id=${ws} and user_id=${agent.id}`;
    await notify({ assigneeId: outsider.id });
    await notify({ workspaceId: otherWs });
    await sql`update tickets set assigned_user_id=${admin.id} where id=${ticket}`;
    await notify();
    await sql`update tickets set assigned_user_id=${agent.id},deleted_at=now() where id=${ticket}`;
    await notify();
    await sql`update tickets set deleted_at=null where id=${ticket}`;
    await sql`update workspaces set suspended_at=now() where id=${ws}`;
    try { await notify(); } finally { await sql`update workspaces set suspended_at=null where id=${ws}`; }
    expect(mails).toHaveLength(0);
  });
  it('keeps the saved assignment when delivery fails', async () => {
    failProvider = true;
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await assign(agent.id)).status).toBe(200);
      expect((await sql`select assigned_user_id from tickets where id=${ticket}`)[0].assigned_user_id).toBe(agent.id);
      expect(mails).toHaveLength(1);
      expect(warning).toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });
  it('rechecks the assignee, opt-out and ticket access after composing the email', async () => {
    const branding = await import('./lib/email-branding.js');
    const compose = branding.composeEmail;
    for (const change of ['assignee', 'preference', 'permission']) {
      await sql`update tickets set assigned_user_id=${agent.id} where id=${ticket}`;
      await sql`update users set assignment_email_enabled=true where id=${agent.id}`;
      await sql`update roles set permissions=null where id=${role}`;
      const raced = spyOn(branding, 'composeEmail').mockImplementation(async args => {
        const email = await compose(args);
        if (change === 'assignee') await sql`update tickets set assigned_user_id=${admin.id} where id=${ticket}`;
        if (change === 'preference') await sql`update users set assignment_email_enabled=false where id=${agent.id}`;
        if (change === 'permission') await sql`update roles set permissions='{}'::jsonb where id=${role}`;
        return email;
      });
      try { await notify(); } finally { raced.mockRestore(); }
    }
    expect(mails).toHaveLength(0);
  });
  it('skips sending when outbound email is unconfigured', async () => {
    const { env } = await import('./lib/env.js');
    const token = env.POSTMARK_SERVER_TOKEN;
    env.POSTMARK_SERVER_TOKEN = '';
    try {
      expect((await assign(agent.id)).status).toBe(200);
      expect(mails).toHaveLength(0);
    } finally { env.POSTMARK_SERVER_TOKEN = token; }
  });
  it('sends nothing when an assignment transaction rolls back', async () => {
    const activity = await import('./lib/ticket-activity.js');
    const failure = spyOn(activity, 'recordTicketActivity').mockRejectedValue(new Error('Synthetic audit failure'));
    try {
      expect((await assign(agent.id)).status).toBe(500);
      expect((await sql`select assigned_user_id from tickets where id=${ticket}`)[0].assigned_user_id).toBeNull();
      expect(mails).toHaveLength(0);
    } finally { failure.mockRestore(); }
  });
});
