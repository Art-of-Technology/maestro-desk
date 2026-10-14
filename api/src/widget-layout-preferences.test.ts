import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { WidgetLayoutPatch } from './routes/me.js';

test('widget layouts validate page-specific IDs, bounds, uniqueness and exact writable fields', () => {
  expect(WidgetLayoutPatch.safeParse({ scope:'dash', layout:{ order:['priority','status'], hidden:['status'] } }).success).toBe(true);
  for (const body of [null, {}, {scope:'all',layout:{order:[],hidden:[]}},
    {scope:'dash',layout:{order:['r-status'],hidden:[]}}, {scope:'report',layout:{order:['status'],hidden:[]}},
    {scope:'dash',layout:{order:['status','status'],hidden:[]}}, {scope:'dash',layout:{order:[],hidden:['status','status']}},
    {scope:'dash',layout:{order:Array(51).fill('status'),hidden:[]}},
    {scope:'dash',layout:{order:['__proto__'],hidden:[]}}, {scope:'dash',layout:{order:[],hidden:[],charts:{}}},
    {scope:'dash',layout:{order:[],hidden:[]},user_id:'other'}, {scope:'dash',layout:{order:[],hidden:[]},workspace_id:'other'}]) {
    expect(WidgetLayoutPatch.safeParse(body).success).toBe(false);
  }
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('private widget layouts', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let workspace: string, other: string, user: string, teammate: string, token: string, otherToken: string;
  const suffix = crypto.randomUUID();
  const request = (scope = 'dash', layout?: unknown, ws = workspace, credential = token) => app.request('/api/v1/me/widget-layouts' + (layout === undefined ? '/' + scope : ''), {
    method: layout === undefined ? 'GET' : 'PATCH',
    headers: { Authorization:`Bearer ${credential}`, 'X-Workspace-Id':ws, 'Content-Type':'application/json',
      'X-Forwarded-For':'2001:db8:911:' + suffix.slice(0,4) + '::1' },
    body: layout === undefined ? undefined : JSON.stringify({scope,layout}),
  });
  const dash = { order:['volume','status','priority'], hidden:['priority'] };
  const report = { order:['r-csat','r-status'], hidden:['r-status'] };
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb(); app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const a: any = await auth.api.signUpEmail({ body:{email:`layout-a-${suffix}@t.test`,password:'password-12345',name:'Layout A'} });
    const b: any = await auth.api.signUpEmail({ body:{email:`layout-b-${suffix}@t.test`,password:'password-12345',name:'Layout B'} });
    user=a.user.id;token=a.token;teammate=b.user.id;otherToken=b.token;
    [workspace,other] = await Promise.all(['a','b'].map(async key => {
      const [w]=await sql`select provision_brand('Layouts',${'layout-'+key+'-'+suffix}) id`;return w.id;
    }));
    for (const ws of [workspace,other]) {
      const [role]=await sql`select id from roles where workspace_id=${ws} and not is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${ws},${user},${role.id})`;
      if(ws===workspace)await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${ws},${teammate},${role.id})`;
    }
  },30000);
  afterAll(async () => {
    for(const id of [workspace,other].filter(Boolean))await sql`delete from workspaces where id=${id}`;
    for(const id of [user,teammate].filter(Boolean))await sql`delete from users where id=${id}`;
  });
  test('authentication, membership and page validation protect both reads and writes',async()=>{
    expect((await request('dash',undefined,workspace,'bad')).status).toBe(401);
    expect((await request('dash',undefined,other,otherToken)).status).toBe(403);
    expect((await request('dash',dash,other,otherToken)).status).toBe(403);
    expect((await request('invalid')).status).toBe(400);
    expect((await request('dash',report)).status).toBe(400);
    const response=await request();expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({layout:null});
  });
  test('saved layouts are private per account and workspace and survive subsequent reads',async()=>{
    const response=await request('dash',dash);expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({layout:dash});
    expect(await (await request()).json()).toEqual({layout:dash});
    expect(await (await request('dash',undefined,workspace,otherToken)).json()).toEqual({layout:null});
    expect(await (await request('dash',undefined,other)).json()).toEqual({layout:null});
    await request('dash',{order:['status'],hidden:[]},workspace,otherToken);
    expect(await (await request()).json()).toEqual({layout:dash});
  });
  test('concurrent page saves preserve each other and statistic preferences',async()=>{
    await sql`update user_preferences set theme='dark',stat_views='{"r-status":"table"}'::jsonb where workspace_id=${workspace} and user_id=${user}`;
    const responses=await Promise.all([request('dash',dash),request('report',report)]);
    expect(responses.map(r=>r.status)).toEqual([200,200]);
    expect(await (await request('dash')).json()).toEqual({layout:dash});
    expect(await (await request('report')).json()).toEqual({layout:report});
    const [row]=await sql`select theme,stat_views from user_preferences where workspace_id=${workspace} and user_id=${user}`;
    expect(row).toMatchObject({theme:'dark',stat_views:{'r-status':'table'}});
  });
  test('a subsequent page save replaces that page snapshot and inactive membership is rejected',async()=>{
    const reset={order:['status','priority','volume'],hidden:[]};
    await request('dash',reset);
    expect(await (await request()).json()).toEqual({layout:reset});
    expect(await (await request('report')).json()).toEqual({layout:report});
    await sql`update workspace_members set active=false where workspace_id=${workspace} and user_id=${teammate}`;
    expect((await request('dash',dash,workspace,otherToken)).status).toBe(403);
  });
});
