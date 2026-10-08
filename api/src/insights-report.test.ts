import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { InsightsQuery, insightsReport } from './lib/insights-report.js';

test('Insights validates ranges, exact dates and export flags', () => {
  for (const query of [{ range: 'bad' }, { end: '2026-02-30T00:00:00Z' }, { end: '0001-01-02T00:00:00Z' }, { end: 'yesterday' }, { export: 'true' }]) {
    expect(InsightsQuery.safeParse(query).success).toBe(false);
  }
  expect(InsightsQuery.parse({})).toEqual({ range: '30d', export: '0' });
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('full-workspace Insights', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let ws: string, other: string, user: string, teammate: string, customer: string, ticket: string, token: string;
  const end = new Date('2026-10-06T12:00:00Z');
  const suffix = crypto.randomUUID();
  const report = (range = '7d', exporting = false, workspace = ws) => insightsReport(workspace,
    InsightsQuery.parse({ range, export: exporting ? '1' : '0', end: end.toISOString() }));
  const request = (query: string, workspace = ws, credential = token) => app.request('/api/v1/reports/insights?' + query, {
    headers: { Authorization: `Bearer ${credential}`, 'X-Workspace-Id': workspace, 'X-Forwarded-For': '2001:db8:909:' + suffix.slice(0, 4) + '::1' },
  });
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({ body: { email: `insights-${suffix}@t.test`, password: 'password-12345', name: 'Same Name' } });
    user = signed.user.id; token = signed.token;
    const [second] = await sql`insert into users(email,name) values (${'insights-other-' + suffix + '@t.test'},'Same Name') returning id`;
    teammate = second.id;
    const [w] = await sql`select provision_brand('Insights', ${'insights-' + suffix}) id`; ws = w.id;
    const [o] = await sql`select provision_brand('Other Insights', ${'insights-other-' + suffix}) id`; other = o.id;
    const [role] = await sql`select id from roles where workspace_id = ${ws} and not is_admin limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${ws},${user},${role.id}),(${ws},${teammate},${role.id})`;
    const [c] = await sql`insert into customers(workspace_id,display_id,first_name) values (${ws},'I-C1','Fixture') returning id`; customer = c.id;
    // 205 tickets at the exact inclusive start. No UI ticket/detail loading occurs.
    await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key,created_at,assigned_user_id,latest_customer_sentiment,sla_state,csat_score)
      select ${ws}::uuid,${customer}::uuid,'I-'||n,'Fixture','resolved','normal','2026-09-30T00:00:00Z'::timestamptz,
        case when n = 1 then ${user}::uuid else ${teammate}::uuid end,'positive','ok',5 from generate_series(1,205) n`;
    const [t] = await sql`select id from tickets where workspace_id = ${ws} and display_id = 'I-1'`; ticket = t.id;
    await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key,created_at,closed_at,closure_reason,sla_state)
      values (${ws},${customer},'CLOSED','Closed','closed','normal','2026-10-01','2026-10-02','spam','breach'),
        (${ws},${customer},'OLD','Old','open','normal','2020-01-01',null,null,'ok'),
        (${ws},${customer},'END','Boundary','open','normal',${end},null,null,'ok'),
        (${ws},${customer},'DELETED','Deleted','open','normal','2026-10-01',null,null,'ok'),
        (${ws},${customer},'MERGED','Merged','open','normal','2026-10-01',null,null,'ok')`;
    await sql`update tickets set deleted_at = now() where workspace_id = ${ws} and display_id = 'DELETED'`;
    await sql`update tickets set merged_into_id = ${ticket} where workspace_id = ${ws} and display_id = 'MERGED'`;
    await sql`update tickets set latest_customer_sentiment = 'angry' where workspace_id = ${ws} and display_id = 'OLD'`;
    await sql`insert into time_entries(workspace_id,ticket_id,user_id,minutes,billable) values
      (${ws},${ticket},${user},30,true),(${ws},${ticket},${teammate},15,false),
      (${other},${ticket},${user},999,true)`;
  }, 30000);
  afterAll(async () => {
    // The deliberately mismatched time row must be removed before its ticket.
    for (const id of [other, ws].filter(Boolean)) await sql`delete from workspaces where id = ${id}`;
    for (const id of [user, teammate].filter(Boolean)) await sql`delete from users where id = ${id}`;
  });
  test('counts every ticket, unopened ratings/time, closures and separate same-name agents', async () => {
    const data = await report();
    const r = data!.report;
    expect(data!.period.start).toBe('2026-09-30T00:00:00.000Z');
    expect(r).toMatchObject({ total: 206, resolved: 205, resolutionRate: 100, slaCompliance: 100, slaBreach: 0, csatCount: 205, avgCSAT: 5, timeTotal: 45, timeBillable: 30 });
    expect(r.csatBuckets).toEqual([0,0,0,0,205]);
    expect(r.agents.filter((a: any) => a.name === 'Same Name')).toHaveLength(2);
    expect(r.timeAgents).toHaveLength(2);
    expect(r.sentimentTrend).toHaveLength(7);
    expect(r.sentimentTrend[0].counts.positive).toBe(205);
    expect(r.sentimentTrend[1].counts.positive).toBe(0);
    const empty = (await report('7d', false, other))!.report;
    expect(empty).toMatchObject({ total: 0, timeTotal: 0, csatCount: 0, resolutionRate: 0 });
    expect(empty.agents).toEqual([]);
  });
  test('all time retains old history and all trend counts with bounded buckets', async () => {
    const r = (await report('all'))!.report;
    expect(r.total).toBe(207);
    expect(r.sentimentTrend[0].start).toBe('2020-01-01');
    expect(r.sentimentTrend.length).toBeLessThanOrEqual(30);
    expect(r.sentimentTrend.reduce((n: number, b: any) => n + b.counts.angry + b.counts.positive, 0)).toBe(r.sentimentScored);
    expect((await report('30d'))!.period.start).toBe('2026-09-07T00:00:00.000Z');
    expect((await report('90d'))!.period.start).toBe('2026-07-09T00:00:00.000Z');
    const empty = (await report('all', false, other))!.report;
    expect(empty.sentimentTrend).toHaveLength(1);
  });
  test('exports use the identical cohort, ratings and time totals', async () => {
    const data = await report();
    const exported = await report('7d', true);
    expect(exported!.period).toEqual(data!.period);
    expect(exported!.tickets).toHaveLength(data!.report.total);
    expect(exported!.tickets!.reduce((n: number, t: any) => n + t.timeTotal, 0)).toBe(45);
    expect(exported!.tickets!.filter((t: any) => t.csat === 5)).toHaveLength(205);
    expect(exported!.tickets!.some((t: any) => ['END', 'OLD', 'DELETED', 'MERGED'].includes(t.id))).toBe(false);
  });
  test('requires workspace membership, supports members and validates HTTP inputs', async () => {
    const response = await request('range=7d&end=' + end.toISOString());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await request('range=bad')).status).toBe(400);
    expect((await request('end=2026-02-30T00:00:00Z')).status).toBe(400);
    expect((await request('range=all', other)).status).toBe(403);
    expect((await request('range=all', ws, 'bad-token')).status).toBe(401);
  });
  test('exports 10,000 rows completely and rejects 10,001 without truncation', async () => {
    await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key,created_at)
      select ${ws}::uuid,${customer}::uuid,'BULK-'||n,'Bulk','pending','normal','2026-10-01'::timestamptz from generate_series(1,9794) n`;
    expect((await report('7d', true))!.tickets).toHaveLength(10000);
    await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key,created_at)
      values (${ws},${customer},'OVER','Over','pending','normal','2026-10-01')`;
    expect((await report())!.report.total).toBe(10001);
    expect(await report('7d', true)).toBeNull();
    const response = await request('range=7d&export=1&end=' + end.toISOString());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'More than 10,000 tickets match. Choose a shorter date range before exporting.' });
  }, 30000);
});
