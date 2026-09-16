import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('personal KB filters', () => {
  let app: {request: (path: string, init?: RequestInit) => Promise<Response>};
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const users: {id:string;token:string}[] = [], workspaces: string[] = [];
  const filters = {category:'Website',market:'es-mx',status:'draft',query:'withdrawal'};
  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const {auth} = await import('./lib/auth.js');
    const run = crypto.randomUUID();
    for (let i=0;i<2;i++) {
      const r:any = await auth.api.signUpEmail({body:{email:`kb-sync-${run}-${i}@t.test`,password:'password-12345',name:'KB sync test'},returnHeaders:true});
      users.push({id:r.response.user.id,token:r.response.token});
      const [{ws}] = await sql`select provision_brand(${'kb-sync-'+run+'-'+i}, ${'kb-sync-'+run+'-'+i}) as ws`;
      workspaces.push(ws);
    }
    for (const [workspace,user] of [[0,0],[0,1],[1,0]]) {
      const [role] = await sql`select id from roles where workspace_id=${workspaces[workspace]} and name='Read Only' limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${workspaces[workspace]},${users[user].id},${role.id},true)`;
    }
  });
  beforeEach(async () => {
    for (const workspace of workspaces) {
      await sql`delete from kb_saved_filters where workspace_id=${workspace}`;
      await sql`delete from kb_filter_transfers where workspace_id=${workspace}`;
    }
  });
  afterAll(async () => {
    for (const id of workspaces) await sql`delete from workspaces where id=${id}`;
    for (const user of users) await sql`delete from users where id=${user.id}`;
  });
  function request(method='GET', path='', body?:object, user=0, workspace=0) {
    return app.request('/api/v1/kb-saved-filters'+path,{method,headers:{Authorization:`Bearer ${users[user].token}`,'X-Workspace-Id':workspaces[workspace],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  }
  async function items(user=0,workspace=0) { return (await (await request('GET','',undefined,user,workspace)).json() as any).items; }
  async function create(name='Review') {
    const response = await request('POST','',{name,filters});
    expect(response.status).toBe(201);
    return (await response.json() as any).item;
  }
  it('round-trips across clients, renames and deletes without modifying criteria', async () => {
    const item = await create();
    expect(await items()).toEqual([item]);
    const renamed = await request('PATCH','/'+item.id,{name:' Daily '});
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as any).item).toEqual({...item,name:'Daily'});
    expect((await request('DELETE','/'+item.id)).status).toBe(204);
    expect(await items()).toEqual([]);
  });
  it('requires membership and never exposes or mutates another owner or workspace', async () => {
    expect((await app.request('/api/v1/kb-saved-filters')).status).toBe(401);
    const item = await create();
    for (const [user,workspace] of [[1,0],[0,1]]) {
      expect(await items(user,workspace)).toEqual([]);
      expect((await request('PATCH','/'+item.id,{name:'Hijack'},user,workspace)).status).toBe(404);
      expect((await request('PATCH','/'+item.id,{is_pinned:true},user,workspace)).status).toBe(404);
      expect((await request('DELETE','/'+item.id,undefined,user,workspace)).status).toBe(204);
    }
    expect((await request('GET','',undefined,1,1)).status).toBe(403);
    expect((await items())[0]).toEqual(item);
    expect((await request('POST','',{name:'Other',filters,user_id:users[0].id},1)).status).toBe(400);
    expect((await request('POST','',{name:'Review',filters},1)).status).toBe(201);
  });
  it('pins and unpins across clients without changing filters or names', async () => {
    const item=await create();
    expect(item.is_pinned).toBe(false);
    expect((await request('PATCH','/'+item.id,{is_pinned:true})).status).toBe(200);
    expect(await items()).toEqual([{...item,is_pinned:true}]);
    await request('PATCH','/'+item.id,{name:'Pinned rename'});
    expect(await items()).toEqual([{...item,name:'Pinned rename',is_pinned:true}]);
    await request('PATCH','/'+item.id,{is_pinned:false});
    expect(await items()).toEqual([{...item,name:'Pinned rename',is_pinned:false}]);
    expect((await request('PATCH','/'+item.id,{is_pinned:'true'})).status).toBe(400);
    expect((await request('PATCH','/'+item.id,{})).status).toBe(400);
  });
  it('rejects malformed criteria, blank/duplicate names and invalid IDs', async () => {
    await create();
    for(const body of [{name:' ',filters},{name:'Bad',filters:{...filters,status:'unknown'}},{name:'Bad',filters:{...filters,query:'x'.repeat(501)}}])
      expect((await request('POST','',body)).status).toBe(400);
    expect((await request('POST','',{name:' review ',filters})).status).toBe(409);
    expect((await request('PATCH','/bad',{name:'No'})).status).toBe(400);
  });
  it('serializes default selection and preserves it after invalid or foreign updates', async () => {
    const first=await create(),second=await create('Second');
    expect(first.is_default).toBe(false);
    const responses=await Promise.all([first,second].map(item=>request('PATCH','/'+item.id,{is_default:true})));
    expect(responses.map(r=>r.status)).toEqual([200,200]);
    const defaults=(await items()).filter((item:{is_default:boolean})=>item.is_default);
    expect(defaults).toHaveLength(1);
    const selected=defaults[0];
    expect((await request('PATCH','/'+crypto.randomUUID(),{is_default:true})).status).toBe(404);
    expect((await items()).find((item:{id:string})=>item.id===selected.id).is_default).toBe(true);
    for(const [user,workspace] of [[1,0],[0,1]]) {
      const created=await request('POST','',{name:'Personal',filters},user,workspace);
      const own=(await created.json() as {item:{id:string}}).item;
      expect((await request('PATCH','/'+own.id,{is_default:true},user,workspace)).status).toBe(200);
      expect((await request('PATCH','/'+first.id,{is_default:true},user,workspace)).status).toBe(404);
      expect((await items(user,workspace))[0].is_default).toBe(true);
    }
    expect((await request('PATCH','/'+selected.id,{is_default:'true'})).status).toBe(400);
    expect((await request('PATCH','/'+selected.id,{is_default:false})).status).toBe(200);
    expect((await items()).some((item:{is_default:boolean})=>item.is_default)).toBe(false);
    await request('PATCH','/'+selected.id,{is_default:true});
    await request('DELETE','/'+selected.id);
    expect((await items()).some((item:{is_default:boolean})=>item.is_default)).toBe(false);
  });
  it('imports atomically, preserves colliding names and receipts survive deletion/retry', async () => {
    await create();
    const local = {items:[{id:'old-browser-id',name:'Review',filters}]};
    expect((await request('POST','/import',local)).status).toBe(200);
    let list = await items();
    expect(list.map((item:any)=>item.name)).toEqual(['Review','Review (imported 1)']);
    expect((await request('POST','/import',local)).status).toBe(200);
    expect(await items()).toHaveLength(2);
    await request('DELETE','/'+list[1].id);
    await request('POST','/import',local);
    expect(await items()).toHaveLength(1);
    const changed = await request('POST','/import',{items:[{...local.items[0],name:'Changed in old tab'}]});
    expect((await changed.json() as any).transferred).toEqual([]);
    expect(await items()).toHaveLength(1);
    // Receipts are also private to an owner and workspace.
    await request('POST','/import',local,1);
    expect(await items(1)).toHaveLength(1);
    await request('POST','/import',local,0,1);
    expect(await items(0,1)).toHaveLength(1);
  });
  it('serializes concurrent devices and rolls back an import that exceeds the cap', async () => {
    for(let i=0;i<24;i++) await create('Filter '+i);
    const transfer = {items:[{id:'a',name:'A',filters},{id:'b',name:'B',filters}]};
    expect((await request('POST','/import',transfer)).status).toBe(409);
    expect(await items()).toHaveLength(24);
    const [receipt] = await sql`select count(*)::int as count from kb_filter_transfers where workspace_id=${workspaces[0]}`;
    expect(receipt.count).toBe(0);
    const responses = await Promise.all(['Last 1','Last 2'].map(name=>request('POST','',{name,filters})));
    expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
    expect(await items()).toHaveLength(25);
    const list = await items();
    await request('DELETE','/'+list[0].id); await request('DELETE','/'+list[1].id);
    expect((await request('POST','/import',transfer)).status).toBe(200);
    expect(await items()).toHaveLength(25);
  });
});
