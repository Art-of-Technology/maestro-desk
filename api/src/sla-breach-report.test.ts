// The SLA breach report endpoint returns per-ticket timing facts (most
// importantly first_agent_reply_at from ticket_messages) so the SPA can
// evaluate breaches with its business-hours engine. Breach math is NOT
// tested here — it lives client-side; this suite pins the endpoint's
// contract: first-reply semantics, range filtering, exclusions, validation,
// and tenant isolation. DB-backed (RUN_DB_TESTS).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('SLA breach report endpoint (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const userA = { email: `sbr-a-${RUN}@t.test` } as Record<string, string>;
  const userB = { email: `sbr-b-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: 'A' }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function report(days: number | string | null, token: string, wsId: string) {
    const qs = days == null ? '' : `?days=${days}`;
    return app.request(`/api/v1/reports/sla-breaches${qs}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': wsId },
    });
  }
  async function provisionMember(slug: string, userId: string): Promise<string> {
    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slug}, ${slug}) as provision_brand`;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${userId}, ${adminRole.id}, true)`;
    return ws;
  }
  async function addTicket(wsId: string, displayId: string, opts: { createdDaysAgo?: number; deleted?: boolean; merged?: boolean; assigned?: string } = {}): Promise<string> {
    const [cust] = await sql<{ id: string }[]>`
      select id from customers where workspace_id = ${wsId} limit 1`;
    const custId = cust?.id ?? (await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name) values (${wsId}, ${'C-' + displayId}, 'C') returning id`)[0].id;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, assigned_user_id)
      values (${wsId}, ${displayId}, 'S', ${custId}, 'open', 'normal', ${opts.assigned ?? null}) returning id`;
    if (opts.createdDaysAgo) {
      await sql`update tickets set created_at = now() - (${opts.createdDaysAgo} * interval '1 day') where id = ${t.id}`;
    }
    if (opts.deleted) await sql`update tickets set deleted_at = now() where id = ${t.id}`;
    if (opts.merged) await sql`update tickets set merged_into_id = ${t.id} where id = ${t.id}`;
    return t.id;
  }
  async function addMsg(wsId: string, ticketId: string, role: string, minutesAfter: number, deleted = false) {
    const [m] = await sql<{ id: string }[]>`
      insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, created_at)
      select ${wsId}, ${ticketId}, ${role}, ${role}, 'x',
             t.created_at + (${minutesAfter} * interval '1 minute')
      from tickets t where t.id = ${ticketId}
      returning id`;
    if (deleted) await sql`update ticket_messages set deleted_at = now() where id = ${m.id}`;
  }
  async function rowsFor(token: string, wsId: string, days = 30): Promise<any[]> {
    const res = await report(days, token, wsId);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    return body.tickets;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const ua = await signUp(userA.email);
    userA.userId = ua.id; userA.token = ua.token;
    const ub = await signUp(userB.email);
    userB.userId = ub.id; userB.token = ub.token;
    ctx.wsA = await provisionMember(`sbra-${RUN}`, userA.userId);
    ctx.wsB = await provisionMember(`sbrb-${RUN}`, userB.userId);
  }, 30000);

  afterAll(async () => {
    for (const ws of [ctx.wsA, ctx.wsB]) {
      await sql`delete from ticket_messages where workspace_id = ${ws}`;
      await sql`update tickets set merged_into_id = null where workspace_id = ${ws}`;
      await sql`delete from tickets where workspace_id = ${ws}`;
    }
  });

  it('computes first_agent_reply_at as the earliest agent/ai message, ignoring notes, system, customer, and deleted rows', async () => {
    const tid = await addTicket(ctx.wsA, `SBR1-${RUN}`, { assigned: userA.userId });
    await addMsg(ctx.wsA, tid, 'customer', 0);
    await addMsg(ctx.wsA, tid, 'note', 5);
    await addMsg(ctx.wsA, tid, 'system', 6);
    await addMsg(ctx.wsA, tid, 'agent', 10, true);   // deleted — must not count
    await addMsg(ctx.wsA, tid, 'ai', 42);
    await addMsg(ctx.wsA, tid, 'agent', 60);         // later than the ai reply
    const rows = await rowsFor(userA.token, ctx.wsA);
    const row = rows.find(r => r.id === tid);
    expect(row).toBeDefined();
    const created = new Date(row.created_at).getTime();
    const firstReply = new Date(row.first_agent_reply_at).getTime();
    expect(Math.round((firstReply - created) / 60000)).toBe(42);
    expect(row.assignee_name).toBe('A');  // users.name joined
  });

  it('returns null first_agent_reply_at for unreplied tickets', async () => {
    const tid = await addTicket(ctx.wsA, `SBR2-${RUN}`);
    await addMsg(ctx.wsA, tid, 'customer', 0);
    const rows = await rowsFor(userA.token, ctx.wsA);
    const row = rows.find(r => r.id === tid);
    expect(row.first_agent_reply_at).toBeNull();
    expect(row.assignee_name).toBeNull();
  });

  it('filters by the days range', async () => {
    const oldTid = await addTicket(ctx.wsA, `SBR3-${RUN}`, { createdDaysAgo: 10 });
    const rows30 = await rowsFor(userA.token, ctx.wsA, 30);
    expect(rows30.some(r => r.id === oldTid)).toBe(true);
    const rows7 = await rowsFor(userA.token, ctx.wsA, 7);
    expect(rows7.some(r => r.id === oldTid)).toBe(false);
  });

  it('excludes soft-deleted and merged tickets', async () => {
    const delTid = await addTicket(ctx.wsA, `SBR4-${RUN}`, { deleted: true });
    const mergedTid = await addTicket(ctx.wsA, `SBR5-${RUN}`, { merged: true });
    const rows = await rowsFor(userA.token, ctx.wsA);
    expect(rows.some(r => r.id === delTid)).toBe(false);
    expect(rows.some(r => r.id === mergedTid)).toBe(false);
  });

  it('rejects invalid days values', async () => {
    expect((await report(14, userA.token, ctx.wsA)).status).toBe(400);
    expect((await report('abc', userA.token, ctx.wsA)).status).toBe(400);
    // Missing days defaults to 30.
    const res = await report(null, userA.token, ctx.wsA);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).days).toBe(30);
  });

  it('is tenant-isolated: workspace B never sees A rows, and B cannot borrow A workspace-id', async () => {
    const rowsB = await rowsFor(userB.token, ctx.wsB);
    expect(rowsB.length).toBe(0);
    // B's token with A's workspace header must be rejected by requireAuth.
    const cross = await report(30, userB.token, ctx.wsA);
    expect(cross.status).toBe(403);
  });
});
