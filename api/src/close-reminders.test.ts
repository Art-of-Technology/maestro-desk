import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

process.env.BETTER_AUTH_SECRET ||= 'synthetic-reminder-test-secret-0123456789';
process.env.ANTHROPIC_API_KEY ||= 'synthetic-reminder-test-key';
(process.env.RUN_DB_TESTS ? describe : describe.skip)('cross-device close reminders', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const agents: { id: string; token: string }[] = [], workspaces: string[] = [];
  let customer: string, foreignTicket: string;
  const data = async (r: Response) => await r.json() as { reminder: { pending: boolean; version: number; generation: number } };
  const request = (id: string, method = 'GET', body?: unknown, agent = 0, ws = workspaces[0]) => app.request(`/api/v1/tickets/${id}/close-reminder`, {
    method, headers: { Authorization: `Bearer ${agents[agent].token}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const ticket = async () => {
    const [row] = await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
      values (${workspaces[0]},${crypto.randomUUID()},'Reminder fixture',${customer},'open','normal') returning id`;
    return row.id as string;
  };
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb(); app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    for (let i=0;i<2;i++) {
      const result = await auth.api.signUpEmail({ body: { email: `reminder-${crypto.randomUUID()}@test.example`, password: 'synthetic-test-password', name: 'Reminder agent' } });
      agents.push({ id:result.user.id, token:result.token! });
      const [{ provision_brand: ws }] = await sql`select provision_brand('Reminder fixture',${crypto.randomUUID()})`;
      workspaces.push(ws);
      const [role] = await sql`select id from roles where workspace_id=${ws} and is_admin limit 1`;
      for (const agent of agents) await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${ws},${agent.id},${role.id},true)`;
    }
    const [role] = await sql`select id from roles where workspace_id=${workspaces[0]} and is_admin limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${workspaces[0]},${agents[1].id},${role.id},true)`;
    const [c] = await sql`insert into customers(workspace_id,display_id,first_name) values (${workspaces[0]},'REM-C','Fixture') returning id`;
    customer=c.id;
    const [otherCustomer] = await sql`insert into customers(workspace_id,display_id,first_name) values (${workspaces[1]},'REM-C','Other') returning id`;
    const [other] = await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
      values (${workspaces[1]},'REM-T','Other',${otherCustomer.id},'open','normal') returning id`;
    foreignTicket=other.id;
  });
  afterAll(async () => {
    if (!sql) return;
    for (const ws of workspaces) await sql`delete from workspaces where id=${ws}`;
    for (const agent of agents) await sql`delete from users where id=${agent.id}`;
  });
  it('shares one agent’s state across devices, isolates identities and rejects stale writes', async () => {
    const id=await ticket();
    expect((await data(await request(id))).reminder).toEqual({pending:false,version:0,generation:0});
    expect((await request(id,'PUT',{pending:true,version:0,generation:0})).status).toBe(200);
    expect((await data(await request(id))).reminder).toEqual({pending:true,version:1,generation:0});
    expect((await data(await request(id,'GET',undefined,1))).reminder).toEqual({pending:false,version:0,generation:0});
    expect((await request(id,'PUT',{pending:false,version:1,generation:0})).status).toBe(200);
    const stale=await request(id,'PUT',{pending:true,version:1,generation:0});
    expect(stale.status).toBe(409);
    expect((await data(stale)).reminder).toEqual({pending:false,version:2,generation:0});
    expect((await request(id,'PUT',{pending:true,version:2,generation:0,user_id:agents[1].id})).status).toBe(400);
    expect((await request(foreignTicket)).status).toBe(404);
    expect((await request(id,'GET',undefined,0,workspaces[1])).status).toBe(404);
    expect((await request('invalid-id')).status).toBe(404);
    const unauthenticated=await app.request(`/api/v1/tickets/${id}/close-reminder`);
    expect(unauthenticated.status).toBe(401);
  });
  it('serializes competing device updates', async () => {
    const id=await ticket();
    const results=await Promise.all([request(id,'PUT',{pending:true,version:0,generation:0}),request(id,'PUT',{pending:false,version:0,generation:0})]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  });
  it('closing, merging and deleting clear all agent reminders without allowing resurrection', async () => {
    for (const mode of ['close','merge','delete']) {
      const id=await ticket();
      for (let agent=0;agent<2;agent++) expect((await request(id,'PUT',{pending:true,version:0,generation:0},agent)).status).toBe(200);
      if (mode==='close') {
        const res=await app.request(`/api/v1/tickets/${id}/close`,{method:'POST',headers:{Authorization:`Bearer ${agents[0].token}`,'X-Workspace-Id':workspaces[0],'Content-Type':'application/json'},body:JSON.stringify({reason:'other'})});
        expect(res.status).toBe(200);
      } else if (mode==='merge') await sql`update tickets set merged_into_id=${await ticket()} where id=${id}`;
      else await sql`update tickets set deleted_at=now() where id=${id}`;
      const rows=await sql`select pending,version from ticket_close_reminders where ticket_id=${id}`;
      expect(rows.map(r=>({pending:r.pending,version:r.version}))).toEqual([{pending:false,version:2},{pending:false,version:2}]);
      if(mode==='delete') {expect((await request(id)).status).toBe(404);continue;}
      expect((await request(id,'PUT',{pending:true,version:1,generation:0})).status).toBe(409);
      expect((await data(await request(id,'PUT',{pending:true,version:2,generation:1}))).reminder.pending).toBe(false);
    }
  });
  it('closure invalidates first offline saves and cleared reminders even after reopening', async () => {
    for (const existing of [false,true]) {
      const id=await ticket();
      if(existing) await request(id,'PUT',{pending:false,version:0,generation:0});
      await sql`update tickets set status_key='closed',closed_at=now() where id=${id}`;
      await sql`update tickets set status_key='open',closed_at=null where id=${id}`;
      const stale=await request(id,'PUT',{pending:true,version:existing?1:0,generation:0});
      expect(stale.status).toBe(409);
      expect((await data(stale)).reminder).toMatchObject({pending:false,generation:1});
    }
  });
  it('does not expose or update reminders for erased customers or inactive members', async () => {
    const id=await ticket();
    await sql`update workspace_members set active=false where workspace_id=${workspaces[0]} and user_id=${agents[1].id}`;
    expect((await request(id,'GET',undefined,1)).status).toBe(403);
    expect((await request(id,'PUT',{pending:true,version:0,generation:0},1)).status).toBe(403);
    await sql`update workspace_members set active=true where workspace_id=${workspaces[0]} and user_id=${agents[1].id}`;
    await sql`update customers set erased_at=now() where id=${customer}`;
    expect((await request(id)).status).toBe(404);
    expect((await request(id,'PUT',{pending:true,version:0,generation:0})).status).toBe(404);
  });
});
