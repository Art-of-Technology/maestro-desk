// The ticket-list endpoint must expose last_message_role so the SPA can derive
// the "new customer response" notification (awaiting reply when it's 'customer')
// without loading every thread. DB-backed (RUN_DB_TESTS).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('ticket list last_message_role (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const admin = { email: `lmr-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: 'A' }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(path: string) {
    return app.request(path, { headers: { Authorization: `Bearer ${admin.token}`, 'X-Workspace-Id': ctx.wsId } });
  }
  async function addMsg(role: string) {
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
              values (${ctx.wsId}, ${ctx.ticketId}, ${role}, ${role}, 'x')`;
    // Bump the ticket so it stays the most-recently-updated row.
    await sql`update tickets set updated_at = now() where id = ${ctx.ticketId}`;
  }
  async function listRole(): Promise<string | null | undefined> {
    const res = await as('/api/v1/tickets?limit=50');
    const { tickets } = await res.json() as any;
    const row = tickets.find((t: any) => t.id === ctx.ticketId);
    return row ? row.last_message_role : undefined;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const ua = await signUp(admin.email);
    admin.userId = ua.id; admin.token = ua.token;
    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'lmr-' + RUN}, ${'lmr-' + RUN}) as provision_brand`;
    ctx.wsId = ws;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${admin.userId}, ${adminRole.id}, true)`;
    const [cust] = await sql<{ id: string }[]>`insert into customers (workspace_id, display_id, first_name) values (${ws}, ${'C-' + RUN}, 'C') returning id`;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ws}, ${'LMR-' + RUN}, 'S', ${cust.id}, 'open', 'normal') returning id`;
    ctx.ticketId = t.id;
  }, 30000);

  afterAll(async () => {
    await sql`delete from ticket_messages where workspace_id = ${ctx.wsId}`;
    await sql`delete from tickets where workspace_id = ${ctx.wsId}`;
  });

  it('reflects the latest message role and flips to customer on a reply', async () => {
    expect(await listRole()).toBeNull();           // no messages yet
    await addMsg('customer');
    expect(await listRole()).toBe('customer');      // initial inbound
    await addMsg('agent');
    expect(await listRole()).toBe('agent');         // agent replied → not awaiting
    await addMsg('customer');
    expect(await listRole()).toBe('customer');      // customer replied again → awaiting
  });
});
