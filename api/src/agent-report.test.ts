import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { AgentReportQuery, agentReport } from './lib/agent-report.js';

test('agent report rejects invalid ranges and agent IDs', () => {
  expect(AgentReportQuery.safeParse({range:'yesterday'}).success).toBe(false);
  expect(AgentReportQuery.safeParse({agentId:'other'}).success).toBe(false);
  expect(AgentReportQuery.parse({}).range).toBe('30d');
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('agent performance totals', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let ws: string, other: string, user: string, teammate: string, token: string, ticket: string;
  const suffix = crypto.randomUUID();
  const end = new Date('2025-09-29T12:00:00Z');
  const request = (path: string, method = 'GET', body?: unknown, workspace = ws) => app.request('/api/v1/' + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace, 'Content-Type': 'application/json', 'X-Forwarded-For': '2001:db8:907:' + suffix.slice(0,4) + '::1' },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const {auth} = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({body:{email:`stats-${suffix}@t.test`,password:'password-12345',name:'Same Name'}});
    user = signed.user.id; token = signed.token;
    const [second] = await sql`insert into users(email,name) values (${'stats-other-'+suffix+'@t.test'},'Same Name') returning id`;
    teammate = second.id;
    const [w] = await sql`select provision_brand('Agent stats', ${'stats-'+suffix}) id`; ws = w.id;
    const [o] = await sql`select provision_brand('Other stats', ${'stats-other-'+suffix}) id`; other = o.id;
    const [role] = await sql`select id from roles where workspace_id = ${ws} and is_admin limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${ws},${user},${role.id}),(${ws},${teammate},${role.id})`;
    const [customer] = await sql`insert into customers(workspace_id,display_id,first_name) values (${ws},'C1','Stats') returning id`;
    await sql`insert into tickets(workspace_id,display_id,customer_id,subject,status_key,priority_key,assigned_user_id)
      select ${ws}::uuid,'STAT-'||n,${customer.id}::uuid,'Stats fixture','pending','normal',${teammate}::uuid from generate_series(1,205) n`;
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_user_id,author_label,body,created_at)
      select ${ws}::uuid,id,'agent',${user}::uuid,'Same Name','Saved reply','2025-09-22T12:00:00Z'::timestamptz from tickets where workspace_id = ${ws}`;
    const [t] = await sql`select id from tickets where workspace_id = ${ws} and display_id = 'STAT-1'`; ticket=t.id;
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,created_at)
      values (${ws},${ticket},'customer','Customer','Help','2025-09-22T11:00:00Z')`;
  },30000);
  afterAll(async () => {
    for (const id of [ws,other].filter(Boolean)) await sql`delete from workspaces where id = ${id}`;
    for (const id of [user,teammate].filter(Boolean)) await sql`delete from users where id = ${id}`;
  });
  test('counts beyond a page, keeps same-name agents separate, and uses event dates', async () => {
    const r = await agentReport(ws,{range:'7d',agentId:user},end);
    expect(r.summaries.find((s:any)=>s.userId===user)).toMatchObject({total:205,replies:205,open:0,avgResponseMin:60});
    expect(r.summaries.find((s:any)=>s.userId===teammate)).toMatchObject({total:0,replies:0,open:205});
    expect(r.detail.tickets).toHaveLength(50);
    expect(r.detail.byStatus).toEqual({pending:205});
    const later = await agentReport(ws,{range:'7d'},new Date(end.getTime()+1));
    expect(later.summaries.find((s:any)=>s.userId===user).total).toBe(0);
    expect((await agentReport(ws,{range:'30d'},end)).summaries.find((s:any)=>s.userId===user).total).toBe(205);
    expect((await agentReport(other,{range:'all',agentId:user},end)).detail.tickets).toEqual([]);
  });
  test('send then resolve credits the actor; invalid writes and retries do not inflate totals', async () => {
    expect((await request(`tickets/${ticket}/messages`,'POST',{role:'agent',body:'Please fill {customer_name}'})).status).toBe(400);
    expect((await request(`tickets/${ticket}/messages`,'POST',{role:'agent',body:'This is resolved.'})).status).toBe(201);
    expect((await request(`tickets/${ticket}`,'PATCH',{status_key:'resolved'})).status).toBe(200);
    expect((await request(`tickets/${ticket}`,'PATCH',{status_key:'resolved'})).status).toBe(200);
    const r:any = await (await request(`reports/agents?range=all&agentId=${user}`)).json();
    expect(r.summaries.find((s:any)=>s.userId===user)).toMatchObject({total:205,resolved:1,replies:206});
    expect(r.summaries.find((s:any)=>s.userId===teammate).resolved).toBe(0);
    expect(r.detail.recent.some((a:any)=>a.role==='resolved')).toBe(true);
    expect((await request(`tickets/${ticket}`,'PATCH',{status_key:'open',assigned_user_id:user})).status).toBe(200);
    expect((await request(`tickets/${ticket}`,'PATCH',{status_key:'resolved'})).status).toBe(200);
    const repeat:any = await (await request('reports/agents?range=all')).json();
    expect(repeat.summaries.find((s:any)=>s.userId===user).resolved).toBe(1);
    expect((await request('reports/agents?range=bad')).status).toBe(400);
    expect((await request('reports/agents?agentId=bad')).status).toBe(400);
    expect((await request('reports/agents','GET',undefined,other)).status).toBe(403);
  });
  test('excludes merged copies and end boundary; includes CSAT only for its recorded resolver', async () => {
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_user_id,author_label,body,created_at,merged_from_id)
      values (${ws},${ticket},'agent',${user},'Same Name','Copied','2025-09-28',${ticket}),
             (${ws},${ticket},'agent',${user},'Same Name','End boundary',${end},null)`;
    // Exercise CSAT attribution using the same durable history helper as status changes.
    const {recordTicketActivity} = await import('./lib/ticket-activity.js');
    await sql.begin(async tx => {
      await tx`select id from tickets where id = ${ticket} for update`;
      await recordTicketActivity(tx,{workspaceId:ws,ticketId:ticket,actorId:user,kind:'status',before:'open',after:'resolved'});
    });
    // Audit history is immutable; use a future report boundary instead of rewriting it.
    await sql`update tickets set csat_score=5,csat_submitted_at=clock_timestamp() where id=${ticket}`;
    const r = await agentReport(ws,{range:'all',agentId:user},new Date(Date.now()+1000));
    expect(r.summaries.find((s:any)=>s.userId===user).csatCount).toBe(1);
    expect(r.detail.csatBuckets).toEqual([0,0,0,0,1]);
    const historical = await agentReport(ws,{range:'7d',agentId:user},end);
    expect(historical.summaries.find((s:any)=>s.userId===user).replies).toBe(205);
  });
});
