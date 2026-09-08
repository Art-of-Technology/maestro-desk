import { beforeAll, afterAll, describe, it, expect } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
runDbTests('ticket number routes', () => {
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const ctx = {} as Record<string, string>;
  const run = Date.now();
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signup: any = await auth.api.signUpEmail({ body: {
      email: `number-route-${run}@test.example`, password: 'test-password-12345', name: 'Route test',
    }, returnHeaders: true });
    ctx.user = signup.response.user.id; ctx.token = signup.response.token;
    for (const key of ['own', 'other']) {
      const [ws] = await sql`select provision_brand(${'url-' + key + run}, ${'url-' + key + run}) as id`;
      ctx[key] = ws.id;
      const [customer] = await sql`insert into customers (workspace_id, display_id, first_name)
        values (${ws.id}, 'M25', 'Route test') returning id`;
      const [ticket] = await sql`insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
        values (${ws.id}, 'TK-58', ${key}, ${customer.id}, 'open', 'normal') returning id`;
      ctx[key + 'Ticket'] = ticket.id;
    }
    const [role] = await sql`select id from roles where workspace_id = ${ctx.own} and is_admin = false limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active)
      values (${ctx.own}, ${ctx.user}, ${role.id}, true)`;
  }, 30000);
  afterAll(async () => {
    for (const workspace of [ctx.own, ctx.other].filter(Boolean)) {
      await sql`delete from workspaces where id = ${workspace}`;
    }
    if (ctx.user) await sql`delete from users where id = ${ctx.user}`;
  });
  const request = (number = 'TK-58', workspace = ctx.own, token = ctx.token) => app.request(`/api/v1/tickets/by-number/${number}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace },
  });
  it('resolves only the authenticated workspace despite duplicate ticket numbers', async () => {
    const res = await request();
    expect(res.status).toBe(200);
    const { ticket }: any = await res.json();
    expect(ticket.id).toBe(ctx.ownTicket);
    expect(ticket.subject).toBe('own');
    expect(ticket.id).not.toBe(ctx.otherTicket);
    expect(ticket).toHaveProperty('last_message_role');
    expect((await request('TK-58', ctx.other)).status).toBe(403);
    expect((await request('TK-58', ctx.own, '')).status).toBe(401);
  });
  it('returns 404 for unknown, malformed and deleted ticket numbers', async () => {
    expect((await request('TK-999999')).status).toBe(404);
    expect((await request('a%20b')).status).toBe(404);
    await sql`update tickets set deleted_at = now() where id = ${ctx.ownTicket}`;
    expect((await request()).status).toBe(404);
  });
});
