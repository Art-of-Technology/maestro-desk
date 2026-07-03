// Audit #9: PATCH /tickets/:id must reject an assigned_user_id that isn't an
// active member of the ticket's workspace (tenant-integrity gap). null clears
// the assignment and is allowed. DB-backed (RUN_DB_TESTS).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('ticket assignee tenant check (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const admin = {} as Record<string, string>;
  const ctx = {} as Record<string, string>;
  const createdUserIds: string[] = [];

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: 'A' }, returnHeaders: true });
    createdUserIds.push(r.response.user.id);
    return { id: r.response.user.id, token: r.response.token };
  }
  function patchAssignee(assigned_user_id: string | null) {
    return app.request(`/api/v1/tickets/${ctx.ticketId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin.token}`, 'X-Workspace-Id': ctx.wsId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_user_id }),
    });
  }
  const assigneeOf = async () => {
    const [t] = await sql<{ assigned_user_id: string | null }[]>`select assigned_user_id from tickets where id = ${ctx.ticketId}`;
    return t?.assigned_user_id;
  };

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const ua = await signUp(`assignee-admin-${RUN}@t.test`);
    admin.userId = ua.id; admin.token = ua.token;
    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'asg-' + RUN}, ${'asg-' + RUN}) as provision_brand`;
    ctx.wsId = ws;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    ctx.roleId = adminRole.id;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${admin.userId}, ${adminRole.id}, true)`;
    const [cust] = await sql<{ id: string }[]>`insert into customers (workspace_id, display_id, first_name) values (${ws}, ${'C-' + RUN}, 'C') returning id`;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ws}, ${'ASG-' + RUN}, 'S', ${cust.id}, 'open', 'normal') returning id`;
    ctx.ticketId = t.id;
  }, 30000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from tickets where workspace_id = ${ctx.wsId}`;
    await sql`delete from customers where workspace_id = ${ctx.wsId}`;
    await sql`delete from workspaces where id = ${ctx.wsId}`;
    if (createdUserIds.length) await sql`delete from users where id in ${sql(createdUserIds)}`;
  });

  it('rejects assigning to a non-member with 400 and does not change the row', async () => {
    const res = await patchAssignee(randomUUID());
    expect(res.status).toBe(400);
    expect(await assigneeOf()).toBeNull();
  });

  it('allows assigning to an active workspace member', async () => {
    const member = await signUp(`assignee-member-${RUN}@t.test`);
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ctx.wsId}, ${member.id}, ${ctx.roleId}, true)`;
    const res = await patchAssignee(member.id);
    expect(res.status).toBe(200);
    expect(await assigneeOf()).toBe(member.id);
  });

  it('allows clearing the assignment with null', async () => {
    const res = await patchAssignee(null);
    expect(res.status).toBe(200);
    expect(await assigneeOf()).toBeNull();
  });
});
