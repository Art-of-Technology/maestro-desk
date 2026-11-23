// DB-backed tests for the SLA-breach sweep (lib/sla-breach-worker.ts) and the
// sla.breach outgoing-webhook event.
//
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/sla-breach-worker.test.ts

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { processSlaBreaches } from './lib/sla-breach-worker.js';

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('SLA breach sweep', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, user: string, token: string, customer: string, hook: string, category: string;
  const suffix = randomUUID();
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  // A ticket with its first customer message, and optionally a first agent reply.
  const makeTicket = async (opts: { ageMin: number; priority?: string; category?: string | null; replyAfterMin?: number;
    fields?: Record<string, unknown> }) => {
    const created = minutesAgo(opts.ageMin);
    const [t] = await sql`insert into tickets ${sql({ workspace_id: ws, display_id: 'TK-' + randomUUID(), customer_id: customer,
      subject: 'SLA sweep test', status_key: 'open', priority_key: opts.priority ?? 'high', category_key: opts.category ?? null,
      created_at: created, ...(opts.fields ?? {}) })} returning id`;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, created_at)
      values (${ws}, ${t.id}, 'customer', 'Customer', 'Hello', ${created})`;
    if (opts.replyAfterMin !== undefined) {
      await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, created_at)
        values (${ws}, ${t.id}, 'agent', 'Agent', 'Hi', ${new Date(created.getTime() + opts.replyAfterMin * 60_000)})`;
    }
    return t.id as string;
  };
  // The sweep is global and takes 100 tickets at a time, so leftovers from
  // other suites in a shared test database may come first; keep going until
  // a pass comes back short.
  const sweep = async () => { for (let i = 0; i < 50; i++) if ((await processSlaBreaches()).scanned < 100) return; };
  const sent = (ticketId: string) => sql<{ payload: any }[]>`
    select payload from webhook_deliveries where webhook_id = ${hook} and event = 'sla.breach'
      and payload->'ticket'->>'id' = ${ticketId} order by created_at`;

  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({ body: { email: `sla-sweep-${suffix}@t.test`, password: 'password-12345', name: 'Sweep Agent' } });
    user = signed.user.id; token = signed.token;
    const [brand] = await sql`select provision_brand(${'SLA sweep'}, ${`sla-sweep-${suffix}`}) as id`;
    ws = brand.id;
    const [role] = await sql`select id from roles where workspace_id = ${ws} and is_admin limit 1`;
    await sql`insert into workspace_members(workspace_id, user_id, role_id) values (${ws}, ${user}, ${role.id})`;
    const [c] = await sql`insert into customers(workspace_id, display_id, first_name, email)
      values (${ws}, 'FIX-1', 'Sweep Person', ${`sweep-${suffix}@t.test`}) returning id`;
    customer = c.id;
    // Only the policies below apply: 'high' answers in 60 min and resolves in
    // 600; 'high' in one category gets far longer; 'low' has an inactive policy only.
    const [cat] = await sql`select key from ticket_categories where workspace_id = ${ws} order by key limit 1`;
    category = cat.key;
    await sql`delete from sla_policies where workspace_id = ${ws}`;
    await sql`insert into sla_policies (workspace_id, display_id, name, priority_key, category_key, first_response_min, resolution_min, status) values
      (${ws}, 'SLA-T1', 'High default', 'high', null, 60, 600, 'active'),
      (${ws}, 'SLA-T2', 'High one category', 'high', ${category.toUpperCase()}, 100000, 200000, 'active'),
      (${ws}, 'SLA-T3', 'Low off', 'low', null, 1, 1, 'inactive')`;
    const [h] = await sql`insert into workspace_webhooks (workspace_id, name, url, secret, events, active)
      values (${ws}, 'SLA test', 'https://example.com/hook', 'test-secret', array['sla.breach'], true) returning id`;
    hook = h.id;
  }, 30000);
  afterAll(async () => {
    if (!sql) return;
    if (ws) await sql`delete from workspaces where id = ${ws}`;
    if (user) await sql`delete from users where id = ${user}`;
  });

  it('accepts sla.breach through the subscription API', async () => {
    const res = await app.request(`/api/v1/integrations/webhooks/${hook}`, { method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: ['sla.breach'] }) });
    expect(res.status).toBe(200);
  });

  it('announces a missed first response once, across repeated sweeps', async () => {
    const unanswered = await makeTicket({ ageMin: 61 });
    const lateReply = await makeTicket({ ageMin: 120, replyAfterMin: 90 });
    const onTime = await makeTicket({ ageMin: 120, replyAfterMin: 10 });
    const fresh = await makeTicket({ ageMin: 30 });
    await sweep(); await sweep();
    for (const id of [unanswered, lateReply]) {
      const rows = await sent(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.data).toEqual({ target: 'first_response' });
      expect(rows[0].payload.ticket.id).toBe(id);
    }
    expect(await sent(onTime)).toHaveLength(0);
    expect(await sent(fresh)).toHaveLength(0);
  });

  it('announces a missed resolution target, and stays quiet once announced even after a reopen', async () => {
    const id = await makeTicket({ ageMin: 601, replyAfterMin: 5 });
    await sweep();
    let rows = await sent(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.data).toEqual({ target: 'resolution' });
    await sql`update tickets set status_key = 'resolved' where id = ${id}`;
    await sql`update tickets set status_key = 'open' where id = ${id}`;
    await sweep();
    rows = await sent(id);
    expect(rows).toHaveLength(1);
  });

  it('follows the policy match: specific category first, no policy means no breach', async () => {
    const specific = await makeTicket({ ageMin: 5000, category });   // the policy stores this category in different casing
    const noPolicy = await makeTicket({ ageMin: 5000, priority: 'normal' });
    const inactivePolicy = await makeTicket({ ageMin: 5000, priority: 'low' });
    await sweep();
    for (const id of [specific, noPolicy, inactivePolicy]) expect(await sent(id)).toHaveLength(0);
  });

  it('leaves resolved and snoozed tickets alone, then announces a snoozed one when it wakes', async () => {
    const resolved = await makeTicket({ ageMin: 5000, fields: { status_key: 'resolved' } });
    const snoozed = await makeTicket({ ageMin: 5000, fields: { snoozed_until: new Date(Date.now() + 3_600_000) } });
    await sweep();
    for (const id of [resolved, snoozed]) expect(await sent(id)).toHaveLength(0);
    await sql`update tickets set snoozed_until = null where id = ${snoozed}`;
    await sweep();
    expect(await sent(snoozed)).toHaveLength(1);
  });

  it('never announces a ticket that predates the feature', async () => {
    const id = await makeTicket({ ageMin: 5000 });
    await sql`insert into ticket_sla_breach_notices (ticket_id, workspace_id, target) values (${id}, ${ws}, 'preexisting')`;
    await sweep();
    expect(await sent(id)).toHaveLength(0);
  });

  it('marks a breach without sending while the webhook is off, and releases no backlog afterwards', async () => {
    const id = await makeTicket({ ageMin: 5000 });
    await sql`update workspace_webhooks set active = false where id = ${hook}`;
    try { await sweep(); }
    finally { await sql`update workspace_webhooks set active = true where id = ${hook}`; }
    expect(await sql`select 1 from ticket_sla_breach_notices where ticket_id = ${id}`).toHaveLength(1);
    await sweep();
    expect(await sent(id)).toHaveLength(0);
  });

  it('leaves no marker behind when queuing the webhook fails, so the next sweep sends it', async () => {
    const id = await makeTicket({ ageMin: 5000 });
    // A delivery row for a webhook that no longer exists cannot be inserted.
    const [doomed] = await sql`insert into workspace_webhooks (workspace_id, name, url, secret, events, active)
      values (${ws}, 'Doomed', 'https://example.com/doomed', 'test-secret', array['sla.breach'], true) returning id`;
    await sql`alter table webhook_deliveries add constraint sla_test_block check (webhook_id <> ${sql.unsafe("'" + doomed.id + "'")}::uuid) not valid`;
    try {
      const result = await processSlaBreaches();
      expect(result.failed).toBeGreaterThan(0);
      expect(await sql`select 1 from ticket_sla_breach_notices where ticket_id = ${id}`).toHaveLength(0);
      expect(await sent(id)).toHaveLength(0);
    } finally {
      await sql`alter table webhook_deliveries drop constraint sla_test_block`;
      await sql`delete from workspace_webhooks where id = ${doomed.id}`;
    }
    await sweep();
    expect(await sent(id)).toHaveLength(1);
  });

  it('skips a suspended brand', async () => {
    const id = await makeTicket({ ageMin: 5000 });
    await sql`update workspaces set suspended_at = now() where id = ${ws}`;
    try {
      await sweep();
      expect(await sent(id)).toHaveLength(0);
    } finally {
      await sql`update workspaces set suspended_at = null where id = ${ws}`;
    }
  });
});
