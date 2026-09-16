import {afterAll,beforeAll,describe,expect,it} from 'bun:test';
import {gapGroups} from './lib/knowledge-gaps.js';
import {recordReplySuggestion} from './lib/reply-feedback.js';

it('groups recurring signals without mixing brands or markets',()=>{
  const t={category_key:'payments',brand:'A',jurisdiction:'UK',unanswered:true,weak:false};
  const groups=gapGroups([{...t,id:'1'},{...t,id:'2'},{...t,id:'3',brand:'B'},{...t,id:'4',jurisdiction:'MT'},{...t,id:'5',unanswered:false}]);
  expect(groups).toHaveLength(1);expect(groups[0].tickets.map(t=>t.id)).toEqual(['1','2']);
});

(process.env.RUN_DB_TESTS?describe:describe.skip)('knowledge gap queue',()=>{
  let app:typeof import('./index.js').default,sql:ReturnType<typeof import('./lib/db.js').getDb>;
  let ws:string,other:string,admin:any,agent:any;
  const run=crypto.randomUUID();
  const request=(path:string,method='GET',body?:unknown,person=admin,workspace=ws)=>app.request('/api/v1/knowledge-gaps'+path,{
    method,headers:{Authorization:`Bearer ${person.token}`,'X-Workspace-Id':workspace,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  async function ticket(brand='A',market='UK',workspace=ws,weak=false){
    const display=crypto.randomUUID();
    const [c]=await sql`insert into customers(workspace_id,display_id,first_name,brand,jurisdiction) values(${workspace},${display},'Test',${brand},${market}) returning id`;
    const [t]=await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
      values(${workspace},${display},'Withdrawal question',${c.id},${weak?'resolved':'open'},'normal') returning id`;
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body) values(${workspace},${t.id},'customer','Test','Where is my withdrawal?')`;
    if(weak){
      const id=await recordReplySuggestion(workspace,agent.user.id,t.id,'Suggested response');
      await sql`insert into ai_reply_feedback(suggestion_id,helpful,reason) values(${id},false,'outdated_advice')`;
    }
    return {id:t.id,customer:c.id};
  }
  beforeAll(async()=>{
    app=(await import('./index.js')).default;sql=(await import('./lib/db.js')).getDb();
    const {auth}=await import('./lib/auth.js');
    [admin,agent]=await Promise.all(['admin','agent'].map(k=>auth.api.signUpEmail({body:{email:`gaps-${k}-${run}@t.test`,password:'test-password-12345',name:k}})));
    [ws,other]=await Promise.all(['a','b'].map(async k=>(await sql`select provision_brand('Gap test',${'gap-'+k+run}) as id`)[0].id));
    for(const [person,workspace,isAdmin] of [[admin,ws,true],[agent,ws,false],[admin,other,true]] as const){
      const [role]=await sql`select id from roles where workspace_id=${workspace} and is_admin=${isAdmin} limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${workspace},${person.user.id},${role.id},true)`;
    }
  },30000);
  afterAll(async()=>{
    if(ws&&other)await sql`delete from workspaces where id in (${ws},${other})`;
    for(const user of [admin,agent])if(user)await sql`delete from users where id=${user.user.id}`;
  });
  it('scans recurring unanswered/weak signals and protects workspace and article workflow',async()=>{
    const a=await ticket(),b=await ticket();
    await ticket('B');await ticket('B');await ticket('A','MT');
    await ticket('C','UK',ws,true);await ticket('C','UK',ws,true);
    await ticket('A','UK',other);await ticket('A','UK',other);
    expect((await request('','GET',undefined,agent)).status).toBe(403);
    expect((await request('/scan','POST',{},agent)).status).toBe(403);
    expect((await request('/scan','POST',{workspace_id:other})).status).toBe(400);
    const scan=await request('/scan','POST',{});expect(scan.status).toBe(200);
    expect(await scan.json()).toMatchObject({scanned:7,groups:3,limited:false});
    const list:any=await (await request('')).json();expect(list.items).toHaveLength(3);
    const gap=list.items.find((g:any)=>g.brand==='A');
    expect(gap.market).toBe('UK');expect(gap.tickets.map((t:any)=>t.id).sort()).toEqual([a.id,b.id].sort());
    expect(((await (await request('','GET',undefined,admin,other)).json()) as any).items).toEqual([]);
    const [article]=await sql`insert into kb_articles(workspace_id,display_id,title,body,status) values(${ws},'KB-GAP','Withdrawal guidance','Draft guidance','draft') returning id`;
    await sql`insert into kb_articles(workspace_id,display_id,title,body,status) values(${other},'KB-FOREIGN','Foreign guidance','Guidance','published')`;
    const update={state:'in_progress',article_display_id:'KB-GAP',note:'Reviewing the withdrawal policy.',version:gap.version};
    expect((await request('/'+gap.id,'PATCH',update,agent)).status).toBe(403);
    expect((await request('/'+gap.id,'PATCH',{...update,article_display_id:''},admin,other)).status).toBe(404);
    expect((await request('/'+gap.id,'PATCH',{...update,article_display_id:'KB-FOREIGN'})).status).toBe(400);
    expect((await request('/'+gap.id,'PATCH',update)).status).toBe(200);
    expect((await request('/'+gap.id,'PATCH',update)).status).toBe(409);
    expect((await request('/'+gap.id,'PATCH',{...update,state:'resolved',note:'',version:1})).status).toBe(400);
    expect((await request('/'+gap.id,'PATCH',{...update,state:'resolved',version:1})).status).toBe(200);
    expect((await sql`select status from kb_articles where id=${article.id}`)[0].status).toBe('draft');
    await request('/scan','POST',{});
    const resolved:any=await (await request('?state=resolved')).json();expect(resolved.items).toHaveLength(1);
    await sql`update customers set erased_at=now() where id=${a.customer}`;
    const redacted:any=await (await request('?state=resolved')).json();expect(redacted.items[0].tickets.map((t:any)=>t.id)).toEqual([b.id]);
    await sql`delete from tickets where id=${b.id}`;
    expect((await sql`select ticket_id from kb_knowledge_gap_tickets where ticket_id=${b.id}`).length).toBe(0);
  });
  it('caps the scan and the visible ticket examples',async()=>{
    const seed=await ticket('Limit');
    const rows=Array.from({length:501},()=>({id:crypto.randomUUID(),workspace_id:ws,display_id:crypto.randomUUID(),subject:'Bounded example',customer_id:seed.customer,status_key:'open',priority_key:'normal'}));
    await sql`insert into tickets ${sql(rows,'id','workspace_id','display_id','subject','customer_id','status_key','priority_key')}`;
    const ids=rows.map(r=>r.id);
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body)
      select ${ws},id,'customer','Test','Unanswered question' from tickets where workspace_id=${ws} and id=any(${ids}::uuid[])`;
    const scan:any=await (await request('/scan','POST',{})).json();
    expect(scan.scanned).toBe(500);expect(scan.limited).toBe(true);
    const list:any=await (await request('')).json();
    expect(list.items.find((g:any)=>g.brand==='Limit').tickets).toHaveLength(20);
  });
});
