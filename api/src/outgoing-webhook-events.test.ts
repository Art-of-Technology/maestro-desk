// DB-backed tests for the outgoing-webhook events fired outside the classic
// status transitions: ticket.assigned, ticket.merged, csat.submitted, and
// ticket.created on every creation path (agent, portal, inbox, inbound email).
//
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/outgoing-webhook-events.test.ts

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { processInboundEmail } from './lib/inbound-email.js';

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('outgoing webhook events', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, user: string, second: string, token: string, customer: string, hook: string;
  const suffix = randomUUID();
  const slug = `hook-events-${suffix}`;
  let ipSeq = 0;
  const headers = () => ({ Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws,
    'X-Forwarded-For': `2001:db8:711:${suffix.slice(0, 4)}::${(ipSeq += 1).toString(16)}`, 'Content-Type': 'application/json' });
  const api = (path: string, method = 'GET', body?: unknown) => app.request(`/api/v1${path}`, {
    method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const open = (path: string, body: unknown) => app.request(`/api/v1/public/${slug}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${(ipSeq += 1)}` }, body: JSON.stringify(body) });
  const makeTicket = async (fields: Record<string, unknown> = {}) => {
    const [t] = await sql`insert into tickets ${sql({ workspace_id: ws, display_id: 'TK-' + randomUUID(), customer_id: customer,
      subject: 'Webhook events test', status_key: 'open', priority_key: 'normal', ...fields })} returning id`;
    return t.id as string;
  };
  const deliveries = (event: string, ticketId?: string) => sql<{ event: string; payload: any }[]>`
    select event, payload from webhook_deliveries where webhook_id = ${hook} and event = ${event}
      and (${ticketId ?? null}::text is null or payload->'ticket'->>'id' = ${ticketId ?? null}) order by created_at`;

  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({ body: { email: `hook-events-${suffix}@t.test`, password: 'password-12345', name: 'Events Agent' } });
    user = signed.user.id; token = signed.token;
    const another: any = await auth.api.signUpEmail({ body: { email: `hook-events-2-${suffix}@t.test`, password: 'password-12345', name: 'Second Agent' } });
    second = another.user.id;
    await sql`update users set assignment_email_enabled=false where id in (${user},${second})`;
    const [brand] = await sql`select provision_brand(${'Hook events'}, ${slug}) as id`;
    ws = brand.id;
    const [role] = await sql`select id from roles where workspace_id = ${ws} and is_admin limit 1`;
    for (const member of [user, second]) await sql`insert into workspace_members(workspace_id, user_id, role_id) values (${ws}, ${member}, ${role.id})`;
    const [c] = await sql`insert into customers(workspace_id, display_id, first_name, email)
      values (${ws}, 'FIX-1', 'Private Person', ${`customer-${suffix}@t.test`}) returning id`;
    customer = c.id;
    const [h] = await sql`insert into workspace_webhooks (workspace_id, name, url, secret, events, active)
      values (${ws}, 'Events test', 'https://example.com/hook', 'test-secret', array['ticket.created'], true) returning id`;
    hook = h.id;
  }, 30000);
  afterAll(async () => {
    if (!sql) return;
    if (ws) await sql`delete from workspaces where id = ${ws}`;
    for (const id of [user, second].filter(Boolean)) await sql`delete from users where id = ${id}`;
  });

  it('accepts the new event names through the subscription API', async () => {
    const events = ['ticket.created', 'ticket.assigned', 'ticket.merged', 'csat.submitted'];
    const res = await api(`/integrations/webhooks/${hook}`, 'PATCH', { events });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).webhook.events).toEqual(events);
    expect((await api(`/integrations/webhooks/${hook}`, 'PATCH', { events: ['ticket.exploded'] })).status).toBe(400);
  });

  it('sends ticket.assigned once per real change of assignee, including unassigning', async () => {
    const id = await makeTicket({ assigned_user_id: user });
    expect((await api(`/tickets/${id}`, 'PATCH', { assigned_user_id: second })).status).toBe(200);
    expect((await api(`/tickets/${id}`, 'PATCH', { assigned_user_id: second })).status).toBe(200);
    let sent = await deliveries('ticket.assigned', id);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.ticket.assigned_user_id).toBe(second);
    expect(sent[0].payload.data).toEqual({ previous_assigned_user_id: user });
    expect((await api(`/tickets/${id}`, 'PATCH', { assigned_user_id: null })).status).toBe(200);
    sent = await deliveries('ticket.assigned', id);
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.ticket.assigned_user_id).toBeNull();
    expect(sent[1].payload.data).toEqual({ previous_assigned_user_id: second });
    // A change that leaves the assignee alone says nothing.
    expect((await api(`/tickets/${id}`, 'PATCH', { priority_key: 'high' })).status).toBe(200);
    expect(await deliveries('ticket.assigned', id)).toHaveLength(2);
  });

  it('sends ticket.assigned when assignment rules move a ticket, and not when they leave it', async () => {
    const id = await makeTicket({ assigned_user_id: user });
    const [rule] = await sql`insert into assign_rules (workspace_id, display_id, name, priority, status, conditions, assignment)
      values (${ws}, ${'AR-' + suffix.slice(0, 8)}, 'Everything to second', 1, 'active', ${sql.json({})},
        ${sql.json({ mode: 'specific-agent', agent_user_id: second })}) returning id`;
    try {
      const first = await api(`/tickets/${id}/apply-rules`, 'POST', {});
      expect(first.status).toBe(200);
      const body: any = await first.json();
      if (!body.matched) throw new Error('fixture rule did not match: ' + JSON.stringify(body));
      expect(body.ticket.assigned_user_id).toBe(second);
      expect((await api(`/tickets/${id}/apply-rules`, 'POST', {})).status).toBe(200);
      const sent = await deliveries('ticket.assigned', id);
      expect(sent).toHaveLength(1);
      expect(sent[0].payload.data).toEqual({ previous_assigned_user_id: user });
    } finally {
      await sql`delete from assign_rules where id = ${rule.id}`;
    }
  });

  it('sends ticket.merged once for the source, naming the primary by id only', async () => {
    const [otherCustomer] = await sql`insert into customers(workspace_id, display_id, first_name, email)
      values (${ws}, 'FIX-2', 'Other Secretname', ${`other-${suffix}@t.test`}) returning id`;
    const source = await makeTicket();
    const primary = await makeTicket({ customer_id: otherCustomer.id });
    const merged = await api(`/tickets/${source}/merge`, 'POST', { into_id: primary });
    expect(merged.status).toBe(200);
    const body: any = await merged.json();
    expect(body.source.id).toBe(source);
    expect(body.primary.id).toBe(primary);
    expect((await api(`/tickets/${source}/merge`, 'POST', { into_id: primary })).status).toBe(409);
    const sent = await deliveries('ticket.merged');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.ticket.id).toBe(source);
    expect(sent[0].payload.data.merged_into).toEqual({ id: primary, display_id: body.primary.display_id });
    expect(JSON.stringify(sent[0].payload)).not.toContain('Secretname');
  });

  it('sends csat.submitted once with the score and never the comment', async () => {
    const surveyToken = `tok-${suffix}`;
    const id = await makeTicket({ status_key: 'resolved', csat_token: surveyToken, csat_requested_at: new Date() });
    const answers = await Promise.all([1, 2].map(() => open(`/csat/${surveyToken}`, { score: 4, comment: 'Confidential remark' })));
    expect(answers.map(r => r.status).sort()).not.toEqual([200, 200]);
    expect(answers.some(r => r.status === 200)).toBe(true);
    const sent = await deliveries('csat.submitted', id);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.data).toEqual({ score: 4 });
    expect(JSON.stringify(sent[0].payload)).not.toContain('Confidential remark');

    // A rating an agent records by hand counts too, once.
    const manual = await makeTicket({ status_key: 'resolved' });
    const rating = { csat_score: 2, csat_stars: 2, csat_comment: 'Agent typed remark', csat_submitted_at: new Date().toISOString() };
    expect((await api(`/tickets/${manual}`, 'PATCH', rating)).status).toBe(200);
    expect((await api(`/tickets/${manual}`, 'PATCH', { priority_key: 'high' })).status).toBe(200);
    const manualSent = await deliveries('csat.submitted', manual);
    expect(manualSent).toHaveLength(1);
    expect(manualSent[0].payload.data).toEqual({ score: 2 });
    expect(JSON.stringify(manualSent[0].payload)).not.toContain('Agent typed remark');

    // Date and score sent in separate requests still announce the rating, once.
    const split = await makeTicket({ status_key: 'resolved' });
    expect((await api(`/tickets/${split}`, 'PATCH', { csat_submitted_at: new Date().toISOString() })).status).toBe(200);
    expect(await deliveries('csat.submitted', split)).toHaveLength(0);
    expect((await api(`/tickets/${split}`, 'PATCH', { csat_score: 5, csat_stars: 5 })).status).toBe(200);
    expect((await api(`/tickets/${split}`, 'PATCH', { priority_key: 'high' })).status).toBe(200);
    const splitSent = await deliveries('csat.submitted', split);
    expect(splitSent).toHaveLength(1);
    expect(splitSent[0].payload.data).toEqual({ score: 5 });
  });

  it('sends ticket.created for portal, inbox and inbound-email tickets, but not for spam', async () => {
    const portal = await open('/tickets', { name: 'Portal Person', email: `portal-${suffix}@t.test`, subject: 'From the portal', body: 'Hello' });
    expect([200, 201]).toContain(portal.status);
    const portalTicket = ((await portal.json()) as any).ticket;
    const [portalRow] = await sql`select id from tickets where workspace_id = ${ws} and display_id = ${portalTicket.display_id}`;
    expect(await deliveries('ticket.created', portalRow.id)).toHaveLength(1);

    const [channel] = await sql`insert into channels(workspace_id, display_id, name, type, address, status)
      values (${ws}, 'CH-FIX', 'Fixture inbox', 'email', ${`fixture-${suffix}@inbound.example.test`}, 'active') returning id`;
    const [message] = await sql`insert into inbox_messages(workspace_id, channel_id, external_id, from_email, subject, body, received_at, status)
      values (${ws}, ${channel.id}, ${'inbox-' + suffix}, ${`customer-${suffix}@t.test`}, 'From the inbox', 'Hello', now(), 'new') returning id`;
    // Two simultaneous conversions of one message make one ticket and one announcement.
    const before = (await deliveries('ticket.created')).length;
    const attempts = await Promise.all([1, 2].map(() => api(`/inbox/${message.id}/convert`, 'POST', {})));
    expect(attempts.map(r => r.status).sort()).toEqual([201, 409]);
    const converted = attempts.find(r => r.status === 201)!;
    expect(await deliveries('ticket.created', ((await converted.json()) as any).ticket.id)).toHaveLength(1);
    expect((await deliveries('ticket.created')).length).toBe(before + 1);
    const [{ count }] = await sql`select count(*)::int as count from tickets where source_inbox_id = ${message.id}`;
    expect(count).toBe(1);

    const inbound = (from: string, id: string) => ({ MessageID: id, From: from, FromFull: { Email: from, Name: 'Mail Person' },
      Subject: 'From email', TextBody: 'Hello by email', HtmlBody: '', ToFull: [{ Email: 'support@inbound.example.test' }],
      Headers: [{ Name: 'Message-Id', Value: `<${id}@cust.test>` }] }) as any;
    const mailed = await processInboundEmail({ workspaceId: ws, payload: inbound(`mail-${suffix}@t.test`, `mail-${suffix}`) });
    // The webhook is queued before the inbound handler returns; only Slack runs behind it.
    expect(await deliveries('ticket.created', mailed.ticket_id)).toHaveLength(1);

    await sql`update customers set is_spam = true where id = ${customer}`;
    try {
      const junk = await processInboundEmail({ workspaceId: ws, payload: inbound(`customer-${suffix}@t.test`, `junk-${suffix}`) });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(await deliveries('ticket.created', junk.ticket_id)).toHaveLength(0);
    } finally {
      await sql`update customers set is_spam = false where id = ${customer}`;
    }
  });
});
