import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { articleLinks, qualityFingerprint, qualitySignals } from './lib/kb-quality.js';
const sample={id:'a',title:'Bonus offer',category:'Website · en',body:'Offer expires 2026-01-01',status:'draft',review_due_date:'2026-01-01'};
test('quality signals explain heuristics and leave intentional link-only articles alone',()=>{
  expect(qualitySignals(sample,'2026-09-16').map(s=>s.kind)).toEqual(['thin','promotion','overdue']);
  expect(qualitySignals({...sample,status:'archived'})).toEqual([]);
  expect(qualitySignals({...sample,title:'Policy',body:'Policy expires 2026-01-01',review_due_date:null},'2026-09-16').map(s=>s.kind)).toEqual(['thin']);
  expect(qualitySignals({...sample,body:'https://example.test/game',review_due_date:null}).map(s=>s.kind)).toEqual(['links']);
  expect(qualitySignals({...sample,duplicates:['KB-2']}).some(s=>s.kind==='duplicate')).toBe(true);
  expect(qualityFingerprint(sample)).not.toBe(qualityFingerprint({...sample,body:'Changed'}));
  expect(articleLinks('[a](https://example.test/a) https://example.test/a https://user:pass@example.test/')).toEqual(['https://example.test/a']);
});

(process.env.RUN_DB_TESTS?describe:describe.skip)('knowledge quality queue',()=>{
  let app: {request:(path:string,init?:RequestInit)=>Promise<Response>};
  let sql:ReturnType<typeof import('./lib/db.js').getDb>;
  const users:{id:string;token:string}[]=[],workspaces:string[]=[],articles:string[]=[];
  beforeAll(async()=>{
    app=(await import('./index.js')).default as typeof app;sql=(await import('./lib/db.js')).getDb();
    const {auth}=await import('./lib/auth.js');const run=crypto.randomUUID();
    for(let i=0;i<2;i++){
      const user:any=await auth.api.signUpEmail({body:{email:`quality-${run}-${i}@t.test`,password:'password-12345',name:'Quality reviewer'},returnHeaders:true});
      users.push({id:user.response.user.id,token:user.response.token});
      const [{ws}]=await sql`select provision_brand(${'quality-'+run+'-'+i},${'quality-'+run+'-'+i}) as ws`;workspaces.push(ws);
      const [admin]=await sql`select id from roles where workspace_id=${ws} and is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${ws},${users[0].id},${admin.id},true)`;
      const [a]=await sql`insert into kb_articles(workspace_id,display_id,title,category,body,status)
        values(${ws},'KB-quality','Bonus offer','Website · en','Offer expires 2026-01-01','draft') returning id`;articles.push(a.id);
    }
    const [role]=await sql`select id from roles where workspace_id=${workspaces[0]} and name='Read Only' limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${workspaces[0]},${users[1].id},${role.id},true)`;
  });
  afterAll(async()=>{for(const ws of workspaces)await sql`delete from workspaces where id=${ws}`;for(const user of users)await sql`delete from users where id=${user.id}`;});
  function request(method='GET',path='',body?:object,user=0,workspace=0){return app.request('/api/v1/kb-quality'+path,{method,headers:{Authorization:`Bearer ${users[user].token}`,'X-Workspace-Id':workspaces[workspace],'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
  async function list(query=''){return (await (await request('GET',query)).json() as any).items;}
  it('scans current content, persists dismissals, and reopens changed content without publishing',async()=>{
    expect((await request('POST','/scan',{})).status).toBe(200);
    const findings=await list();expect(findings.map((f:any)=>f.kind).sort()).toEqual(['promotion','thin']);
    const thin=findings.find((f:any)=>f.kind==='thin');
    expect((await request('PATCH','/'+thin.id,{state:'dismissed',note:'Reviewed short answer'})).status).toBe(200);
    await request('POST','/scan',{});
    expect((await list()).map((f:any)=>f.kind)).toEqual(['promotion']);
    expect((await list('?state=dismissed'))[0].note).toBe('Reviewed short answer');
    await sql`update kb_articles set body='New short content' where workspace_id=${workspaces[0]} and id=${articles[0]}`;
    expect((await list('?state=dismissed'))[0].stale).toBe(true);
    expect((await request('PATCH','/'+thin.id,{state:'open',note:''})).status).toBe(409);
    await request('POST','/scan',{});
    expect((await list()).map((f:any)=>f.kind)).toEqual(['thin']);
    expect(await list('?state=dismissed')).toEqual([]);
    const [a]=await sql`select status from kb_articles where workspace_id=${workspaces[0]} and id=${articles[0]}`;expect(a.status).toBe('draft');
  });
  it('protects every endpoint and rejects cross-workspace finding and link access',async()=>{
    const finding=(await list())[0];
    expect((await app.request('/api/v1/kb-quality')).status).toBe(401);
    for(const [method,path,body] of [['GET','',undefined],['POST','/scan',{}],['PATCH','/'+finding.id,{state:'dismissed',note:''}],['POST','/'+articles[0]+'/check-links',{}]] as const){
      expect((await request(method,path,body,1)).status).toBe(403);
    }
    expect((await request('PATCH','/'+finding.id,{state:'dismissed',note:''},0,1)).status).toBe(404);
    expect((await request('POST','/'+articles[0]+'/check-links',{},0,1)).status).toBe(404);
    expect((await (await request('GET','',undefined,0,1)).json() as any).items).toEqual([]);
    expect((await request('PATCH','/'+finding.id,{state:'dismissed',note:'',workspace_id:workspaces[1]})).status).toBe(400);
    expect((await request('POST','/scan',{after:'bad'})).status).toBe(400);
    expect((await request('GET','?offset=-1')).status).toBe(400);
  });
  it('matches duplicates only within the same workspace and category and hides archived articles',async()=>{
    await sql`insert into kb_articles(workspace_id,display_id,title,category,body,status) values
      (${workspaces[0]},'KB-copy','Copy','Website · en','New short content','draft'),
      (${workspaces[0]},'KB-other-market','Copy','Website · es-mx','New short content','draft')`;
    await request('POST','/scan',{});
    const duplicates=await list('?kind=duplicate');expect(duplicates).toHaveLength(2);
    expect(duplicates.some((d:any)=>d.display_id==='KB-other-market')).toBe(false);
    await sql`update kb_articles set status='archived' where workspace_id=${workspaces[0]} and id=${articles[0]}`;
    expect((await list()).some((d:any)=>d.article_id===articles[0])).toBe(false);
    await request('POST','/scan',{});expect(await list('?kind=duplicate')).toEqual([]);
  });
  it('limits link checks to three links, persists inconclusive flags and never changes publication',async()=>{
    const [article]=await sql`insert into kb_articles(workspace_id,display_id,title,category,body,status)
      values(${workspaces[0]},'KB-links','Links','Policy','http://example.test/a http://example.test/b http://example.test/c http://example.test/d','draft') returning id`;
    const first=await request('POST','/'+article.id+'/check-links',{});
    expect(first.status).toBe(200);
    const data=await first.json() as any;expect(data.results).toHaveLength(3);expect(data.next).toBe(3);
    expect(data.results.every((r:any)=>r.result==='unverified')).toBe(true);
    const second=await (await request('POST','/'+article.id+'/check-links',{offset:3})).json() as any;
    expect(second.results).toHaveLength(1);expect(second.next).toBeNull();
    expect(await list('?kind=broken_links')).toEqual([]);
    expect((await list('?kind=unverified_links'))[0].article_id).toBe(article.id);
    const [stored]=await sql`select status from kb_articles where workspace_id=${workspaces[0]} and id=${article.id}`;expect(stored.status).toBe('draft');
  });
  it('pages scans and queue results without skipping a stable article set',async()=>{
    for(let i=0;i<52;i++)await sql`insert into kb_articles(workspace_id,display_id,title,category,body,status)
      values(${workspaces[1]},${'KB-page-'+i},${'Article '+i},'Policy',${'Short unique '+i},'draft')`;
    const first=await (await request('POST','/scan',{},0,1)).json() as any;
    expect(first.scanned).toBe(50);expect(first.next).toBeTruthy();
    const last=await (await request('POST','/scan',{after:first.next},0,1)).json() as any;
    expect(last.scanned).toBe(3);expect(last.next).toBeNull();
    const page1=await (await request('GET','?kind=thin',undefined,0,1)).json() as any;
    const page2=await (await request('GET','?kind=thin&offset=50',undefined,0,1)).json() as any;
    expect(page1.items).toHaveLength(50);expect(page1.hasMore).toBe(true);
    expect(page2.items).toHaveLength(3);expect(page2.hasMore).toBe(false);
    expect(new Set([...page1.items,...page2.items].map((i:any)=>i.article_id)).size).toBe(53);
  });
});
