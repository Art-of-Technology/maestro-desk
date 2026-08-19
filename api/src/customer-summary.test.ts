// The per-customer profile endpoints (GET /customers/:id/summary and
// /:id/tickets). These exist because the SPA used to derive every number on
// the profile from its first page of TICKETS — and list rows carry no tags, no
// csat_score and no messages, so three of the profile's panels were
// structurally empty on any live workspace.
//
// This suite pins the contract that replaced that: aggregates over the
// customer's FULL history (not a page), the shared list-row shape, paging,
// tenant isolation, and that tickets moved by a customer merge follow the
// survivor. DB-backed (RUN_DB_TESTS).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('customer profile summary endpoints (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const userA = { email: `csum-a-${RUN}@t.test` } as Record<string, string>;
  const userB = { email: `csum-b-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: 'A' }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  async function provisionMember(slug: string, userId: string): Promise<string> {
    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${slug}, ${slug}) as provision_brand`;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${userId}, ${adminRole.id}, true)`;
    return ws;
  }
  async function addCustomer(wsId: string, displayId: string): Promise<string> {
    const [c] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, last_name)
      values (${wsId}, ${displayId}, 'T', 'C') returning id`;
    return c.id;
  }
  async function addTicket(wsId: string, custId: string, displayId: string, opts: {
    status?: string; sla?: string; csat?: number | null; deleted?: boolean; tags?: string[];
  } = {}): Promise<string> {
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, sla_state, csat_score)
      values (${wsId}, ${displayId}, 'S', ${custId}, ${opts.status ?? 'open'}, 'normal',
              ${opts.sla ?? 'ok'}, ${opts.csat ?? null})
      returning id`;
    if (opts.deleted) await sql`update tickets set deleted_at = now() where id = ${t.id}`;
    for (const tag of opts.tags ?? []) {
      await sql`insert into ticket_tags (workspace_id, ticket_id, tag) values (${wsId}, ${t.id}, ${tag})`;
    }
    return t.id;
  }
  async function addMsg(wsId: string, ticketId: string, role: string, body: string, opts: { mergedFrom?: string; deleted?: boolean } = {}) {
    const [m] = await sql<{ id: string }[]>`
      insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, merged_from_id)
      values (${wsId}, ${ticketId}, ${role}, ${role}, ${body}, ${opts.mergedFrom ?? null}) returning id`;
    if (opts.deleted) await sql`update ticket_messages set deleted_at = now() where id = ${m.id}`;
  }
  function summary(custId: string, token: string, wsId: string) {
    return app.request(`/api/v1/customers/${custId}/summary`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': wsId },
    });
  }
  function ticketPage(custId: string, token: string, wsId: string, qs = '') {
    return app.request(`/api/v1/customers/${custId}/tickets${qs}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': wsId },
    });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const ua = await signUp(userA.email);
    userA.userId = ua.id; userA.token = ua.token;
    const ub = await signUp(userB.email);
    userB.userId = ub.id; userB.token = ub.token;
    ctx.wsA = await provisionMember(`csuma-${RUN}`, userA.userId);
    ctx.wsB = await provisionMember(`csumb-${RUN}`, userB.userId);
  }, 30000);

  afterAll(async () => {
    for (const ws of [ctx.wsA, ctx.wsB]) {
      await sql`delete from ticket_messages where workspace_id = ${ws}`;
      await sql`delete from ticket_tags where workspace_id = ${ws}`;
      await sql`update tickets set merged_into_id = null where workspace_id = ${ws}`;
      await sql`delete from tickets where workspace_id = ${ws}`;
      await sql`update customers set merged_into_customer_id = null where workspace_id = ${ws}`;
      // customer_merges FKs both sides, so the journal has to go before the rows.
      await sql`delete from customer_merges where workspace_id = ${ws}`;
      await sql`delete from customer_notes where workspace_id = ${ws}`;
      await sql`delete from customers where workspace_id = ${ws}`;
    }
  });

  it('aggregates the full history, not one page, and excludes soft-deleted tickets', async () => {
    const cust = await addCustomer(ctx.wsA, `C-AGG-${RUN}`);
    await addTicket(ctx.wsA, cust, `AG1-${RUN}`, { status: 'open', sla: 'breach', csat: 5 });
    await addTicket(ctx.wsA, cust, `AG2-${RUN}`, { status: 'open', sla: 'ok', csat: 3 });
    await addTicket(ctx.wsA, cust, `AG3-${RUN}`, { status: 'resolved', sla: 'breach' });
    await addTicket(ctx.wsA, cust, `AG4-${RUN}`, { status: 'escalated' });
    await addTicket(ctx.wsA, cust, `AG5-${RUN}`, { status: 'open', deleted: true, csat: 1 });

    const res = await summary(cust, userA.token, ctx.wsA);
    expect(res.status).toBe(200);
    const b = await res.json() as any;

    expect(b.totals.tickets).toBe(4);              // the deleted one is excluded
    expect(b.totals.sla_breaches).toBe(2);
    expect(b.totals.csat_count).toBe(2);           // deleted ticket's score excluded
    expect(b.totals.csat_avg).toBeCloseTo(4, 5);
    expect(b.by_status).toEqual({ open: 2, resolved: 1, escalated: 1 });
    expect(b.totals.first_ticket_at).toBeTruthy();
  });

  it('reports csat_avg as null rather than 0 when nothing is rated', async () => {
    const cust = await addCustomer(ctx.wsA, `C-NOCSAT-${RUN}`);
    await addTicket(ctx.wsA, cust, `NC1-${RUN}`);
    const b = await (await summary(cust, userA.token, ctx.wsA)).json() as any;
    // 0 would render as a real "0.0 average"; null is "no ratings yet".
    expect(b.totals.csat_avg).toBeNull();
    expect(b.totals.csat_count).toBe(0);
  });

  it('returns an empty-but-valid summary for a customer with no tickets', async () => {
    const cust = await addCustomer(ctx.wsA, `C-EMPTY-${RUN}`);
    const b = await (await summary(cust, userA.token, ctx.wsA)).json() as any;
    expect(b.totals.tickets).toBe(0);
    expect(b.by_status).toEqual({});
    expect(b.tags).toEqual([]);
    expect(b.activity).toEqual([]);
    expect(b.tickets.rows).toEqual([]);
    expect(b.tickets.total).toBe(0);
  });

  it('ranks tags by frequency and caps the list', async () => {
    const cust = await addCustomer(ctx.wsA, `C-TAGS-${RUN}`);
    await addTicket(ctx.wsA, cust, `TG1-${RUN}`, { tags: ['withdrawal', 'bonus'] });
    await addTicket(ctx.wsA, cust, `TG2-${RUN}`, { tags: ['withdrawal'] });
    await addTicket(ctx.wsA, cust, `TG3-${RUN}`, { tags: ['withdrawal', 'bonus'] });
    const b = await (await summary(cust, userA.token, ctx.wsA)).json() as any;
    expect(b.tags[0]).toEqual({ tag: 'withdrawal', n: 3 });
    expect(b.tags[1]).toEqual({ tag: 'bonus', n: 2 });
    expect(b.tags.length).toBeLessThanOrEqual(8);
  });

  it('returns recent messages, excluding deleted and merge-copied rows', async () => {
    const cust = await addCustomer(ctx.wsA, `C-ACT-${RUN}`);
    const t1 = await addTicket(ctx.wsA, cust, `AC1-${RUN}`);
    const other = await addTicket(ctx.wsA, cust, `AC2-${RUN}`);
    await addMsg(ctx.wsA, t1, 'customer', 'hello there');
    await addMsg(ctx.wsA, t1, 'agent', 'deleted one', { deleted: true });
    await addMsg(ctx.wsA, t1, 'agent', 'merge copy', { mergedFrom: other });
    await addMsg(ctx.wsA, t1, 'agent', 'a real reply');

    const b = await (await summary(cust, userA.token, ctx.wsA)).json() as any;
    const bodies = b.activity.map((m: any) => m.body);
    expect(bodies).toContain('hello there');
    expect(bodies).toContain('a real reply');
    expect(bodies).not.toContain('deleted one');
    expect(bodies).not.toContain('merge copy');
    expect(b.activity[0].display_id).toBeTruthy();   // ticket display id is carried through
  });

  it('truncates long message bodies and flags that it did', async () => {
    const cust = await addCustomer(ctx.wsA, `C-TRUNC-${RUN}`);
    const t = await addTicket(ctx.wsA, cust, `TR1-${RUN}`);
    await addMsg(ctx.wsA, t, 'customer', 'x'.repeat(500));
    const b = await (await summary(cust, userA.token, ctx.wsA)).json() as any;
    expect(b.activity[0].body.length).toBe(300);
    expect(b.activity[0].body_truncated).toBe(true);
  });

  it('ships page 0 of the ticket list in the shared list-row shape', async () => {
    const cust = await addCustomer(ctx.wsA, `C-SHAPE-${RUN}`);
    await addTicket(ctx.wsA, cust, `SH1-${RUN}`);
    const b = await (await summary(cust, userA.token, ctx.wsA)).json() as any;
    const row = b.tickets.rows[0];
    // The SPA inserts these straight into TICKETS via updateOrInsertTicket,
    // which assigns every field unconditionally — a missing key would null out
    // live data, so the shape has to match GET /tickets exactly.
    for (const k of ['id', 'display_id', 'subject', 'status_key', 'priority_key', 'category_key',
                     'assigned_user_id', 'customer_id', 'sla_state', 'created_at', 'updated_at',
                     'snoozed_until', 'merged_into_id', 'latest_customer_sentiment', 'last_message_role']) {
      expect(row).toHaveProperty(k);
    }
    expect(row).toHaveProperty('csat_score');   // profile-only extra
    expect(row).not.toHaveProperty('total_count');
  });

  it('pages tickets, returning total only on the first page', async () => {
    const cust = await addCustomer(ctx.wsA, `C-PAGE-${RUN}`);
    for (let i = 0; i < 5; i++) await addTicket(ctx.wsA, cust, `PG${i}-${RUN}`);

    const first = await (await ticketPage(cust, userA.token, ctx.wsA, '?limit=2&offset=0')).json() as any;
    expect(first.rows.length).toBe(2);
    expect(first.total).toBe(5);

    const second = await (await ticketPage(cust, userA.token, ctx.wsA, '?limit=2&offset=2')).json() as any;
    expect(second.rows.length).toBe(2);
    expect(second.total).toBeUndefined();   // omitted, not null — matches GET /tickets

    const firstIds = first.rows.map((r: any) => r.id);
    expect(second.rows.some((r: any) => firstIds.includes(r.id))).toBe(false);
  });

  it('follows tickets moved by a customer merge to the survivor', async () => {
    const survivor = await addCustomer(ctx.wsA, `C-SURV-${RUN}`);
    const dupe = await addCustomer(ctx.wsA, `C-DUPE-${RUN}`);
    await addTicket(ctx.wsA, survivor, `MG1-${RUN}`);
    const moved = await addTicket(ctx.wsA, dupe, `MG2-${RUN}`);

    const before = await (await summary(survivor, userA.token, ctx.wsA)).json() as any;
    expect(before.totals.tickets).toBe(1);

    // :id is the profile being merged AWAY; into_id is the survivor.
    const res = await app.request(`/api/v1/customers/${dupe}/merge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.token}`, 'X-Workspace-Id': ctx.wsA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ into_id: survivor }),
    });
    expect(res.status).toBe(200);

    const after = await (await summary(survivor, userA.token, ctx.wsA)).json() as any;
    expect(after.totals.tickets).toBe(2);
    expect(after.tickets.rows.map((r: any) => r.id)).toContain(moved);
  });

  it('404s a customer from another workspace identically to one that does not exist', async () => {
    const cust = await addCustomer(ctx.wsA, `C-ISO-${RUN}`);
    await addTicket(ctx.wsA, cust, `IS1-${RUN}`);

    const cross = await summary(cust, userB.token, ctx.wsB);
    expect(cross.status).toBe(404);
    const missing = await summary('00000000-0000-0000-0000-000000000000', userB.token, ctx.wsB);
    expect(missing.status).toBe(404);
    expect(await cross.json()).toEqual(await missing.json());

    expect((await ticketPage(cust, userB.token, ctx.wsB)).status).toBe(404);
  });

  it('404s a malformed id without touching the database', async () => {
    expect((await summary('not-a-uuid', userA.token, ctx.wsA)).status).toBe(404);
    expect((await ticketPage('not-a-uuid', userA.token, ctx.wsA)).status).toBe(404);
  });

  it('requires authentication', async () => {
    const cust = await addCustomer(ctx.wsA, `C-AUTH-${RUN}`);
    const res = await app.request(`/api/v1/customers/${cust}/summary`, { headers: { 'X-Workspace-Id': ctx.wsA } });
    expect(res.status).toBe(401);
  });
});
