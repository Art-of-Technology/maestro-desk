import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('KB review ownership', () => {
  let app: {request: (path: string, init?: RequestInit) => Promise<Response>};
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const users: {id:string;token:string}[] = [], workspaces: string[] = [], articles: string[] = [];
  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const run = crypto.randomUUID();
    for (let i=0; i<3; i++) {
      const r:any = await auth.api.signUpEmail({body:{email:`review-${run}-${i}@t.test`,password:'password-12345',name:`Review member ${i}`},returnHeaders:true});
      users.push({id:r.response.user.id,token:r.response.token});
    }
    for (let i=0; i<2; i++) {
      const [{ws}] = await sql`select provision_brand(${'review-'+run+'-'+i}, ${'review-'+run+'-'+i}) as ws`;
      workspaces.push(ws);
      const [role] = await sql`select id from roles where workspace_id=${ws} and is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${ws},${users[0].id},${role.id},true)`;
      const [article] = await sql`insert into kb_articles(workspace_id,display_id,title,category,body,status)
        values(${ws},'KB-review','Review policy','Policy','Policy content','draft') returning id`;
      articles.push(article.id);
    }
    const [reader] = await sql`select id from roles where workspace_id=${workspaces[0]} and name='Read Only' limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${workspaces[0]},${users[1].id},${reader.id},true)`;
  });
  afterAll(async () => {
    for (const id of workspaces) await sql`delete from workspaces where id=${id}`;
    for (const user of users) await sql`delete from users where id=${user.id}`;
  });
  function request(method='GET', path='', body?:object, user=0, workspace=0) {
    return app.request('/api/v1/kb-articles'+path,{method,headers:{Authorization:`Bearer ${users[user].token}`,'X-Workspace-Id':workspaces[workspace],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  }
  const body = () => ({owner_user_id:users[1].id,review_due_date:'2026-09-20'});
  it('persists an owner and date, records review only when requested and preserves publication state', async () => {
    const first = await request('PATCH',`/${articles[0]}/review`,body());
    expect(first.status).toBe(200);
    expect((await first.json() as any).review).toMatchObject({...body(),owner_name:'Review member 1',reviewed_at:null});
    const reviewed = await request('PATCH',`/${articles[0]}/review`,{...body(),mark_reviewed:true});
    const timestamp = (await reviewed.json() as any).review.reviewed_at;
    expect(timestamp).toBeTruthy();
    const cleared = await request('PATCH',`/${articles[0]}/review`,{owner_user_id:null,review_due_date:null});
    expect((await cleared.json() as any).review).toEqual({owner_user_id:null,owner_name:null,review_due_date:null,reviewed_at:timestamp});
    const list = await (await request()).json() as any;
    expect(list.articles.find((a:any)=>a.id===articles[0])).toMatchObject({status:'draft',owner_user_id:null,review_due_date:null,reviewed_at:timestamp});
  });
  it('requires admin rights and scopes article and owner access to the active workspace', async () => {
    expect((await app.request('/api/v1/kb-articles/review-owners')).status).toBe(401);
    expect((await request('GET','/review-owners',undefined,1)).status).toBe(403);
    expect((await request('PATCH',`/${articles[0]}/review`,body(),1)).status).toBe(403);
    expect((await request('PATCH',`/${articles[0]}/review`,body(),0,1)).status).toBe(404);
    expect((await request('PATCH',`/${articles[1]}/review`,body(),0,1)).status).toBe(400);
    expect((await request('PATCH',`/${articles[0]}/review`,{...body(),owner_user_id:users[2].id})).status).toBe(400);
    const owners = (await (await request('GET','/review-owners')).json() as any).owners;
    expect(owners.map((o:any)=>o.id).sort()).toEqual([users[0].id,users[1].id].sort());
  });
  it('rejects impossible dates, malformed identifiers and extra fields', async () => {
    for (const update of [{...body(),review_due_date:'2026-02-30'},{...body(),review_due_date:'2026-09-20T00:00:00Z'},
      {...body(),owner_user_id:'invalid'},{...body(),workspace_id:workspaces[1]}, {...body(),reviewed_at:'2026-01-01'}]) {
      expect((await request('PATCH',`/${articles[0]}/review`,update)).status).toBe(400);
    }
    expect((await request('PATCH','/invalid/review',body())).status).toBe(400);
  });
  it('does not expose removed or inactive owners and refuses to assign them', async () => {
    await request('PATCH',`/${articles[0]}/review`,body());
    await sql`update workspace_members set active=false where workspace_id=${workspaces[0]} and user_id=${users[1].id}`;
    expect((await request('PATCH',`/${articles[0]}/review`,body())).status).toBe(400);
    const list = await (await request()).json() as any;
    expect(list.articles.find((a:any)=>a.id===articles[0]).owner_name).toBeNull();
    expect((await (await request('GET','/review-owners')).json() as any).owners).toHaveLength(1);
    await sql`update workspace_members set active=true where workspace_id=${workspaces[0]} and user_id=${users[1].id}`;
    await sql`update users set deleted_at=now() where id=${users[1].id}`;
    expect((await request('PATCH',`/${articles[0]}/review`,body())).status).toBe(400);
  });
});
