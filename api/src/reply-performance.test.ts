import { beforeAll, afterAll, describe, expect, it, spyOn } from 'bun:test';
import { recordReplySuggestion, recordReplyUse } from './lib/reply-feedback.js';
import * as feedback from './lib/reply-feedback.js';
import { ReplyPerformanceQuery } from './lib/reply-performance.js';

it('rejects invalid, reversed and excessive reporting periods',()=>{
  for(const range of [{start:'invalid',end:'2026-09-02T00:00:00Z'},
    {start:'2026-09-03T00:00:00Z',end:'2026-09-02T00:00:00Z'},
    {start:'2024-01-01T00:00:00Z',end:'2026-09-02T00:00:00Z'}]) expect(ReplyPerformanceQuery.safeParse(range).success).toBe(false);
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('AI reply performance reporting',()=>{
  let app: typeof import('./index.js').default,sql:ReturnType<typeof import('./lib/db.js').getDb>;
  let ws:string,other:string,admin:any,agent:any,second:any,tid:string,foreign:string;
  let known:string,legacy:string;
  const run=crypto.randomUUID();
  const filters={start:'2026-09-01T00:00:00Z',end:'2026-09-03T00:00:00Z'};
  const request=(path:string,person=admin,body?:unknown,workspace=ws)=>app.request('/api/v1/'+path,{
    method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${person.token}`,'X-Workspace-Id':workspace,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  const report=(extra:Record<string,string>={},person=admin,workspace=ws)=>request('reports/reply-performance?'+new URLSearchParams({...filters,...extra}),person,undefined,workspace);
  async function ticket(workspace=ws){
    const id=crypto.randomUUID();
    const [c]=await sql`insert into customers(workspace_id,display_id,first_name) values (${workspace},${id},'Synthetic') returning id`;
    const [t]=await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
      values (${workspace},${id},'Synthetic question',${c.id},'open','normal') returning id`;
    return t.id as string;
  }
  const post=(ticketId:string,person:any,suggestion?:string,body='Original suggestion',role='agent')=>request(`tickets/${ticketId}/messages`,person,{role,body,...(suggestion?{reply_suggestion_id:suggestion}:{})});
  async function snapshot(person=agent,context:'reply'|'note'|undefined='reply',ticketId=tid,cost=2000){
    return (await recordReplySuggestion(ws,person.user.id,ticketId,'Original suggestion',[],context?{context,costMicro:cost}:undefined))!;
  }
  beforeAll(async()=>{
    app=(await import('./index.js')).default;sql=(await import('./lib/db.js')).getDb();
    const {auth}=await import('./lib/auth.js');
    [admin,agent,second]=await Promise.all(['admin','agent','second'].map(k=>auth.api.signUpEmail({body:{email:`performance-${k}-${run}@t.test`,password:'test-password-12345',name:k}})));
    [ws,other]=await Promise.all(['a','b'].map(async k=>(await sql`select provision_brand('Performance test',${'performance-'+k+run}) as id`)[0].id));
    for(const person of [admin,agent,second]){
      const [role]=await sql`select id from roles where workspace_id=${ws} and is_admin=${person===admin} limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${ws},${person.user.id},${role.id},true)`;
    }
    const [role]=await sql`select id from roles where workspace_id=${other} and is_admin=true limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${other},${admin.user.id},${role.id},true)`;
    tid=await ticket();foreign=await ticket(other);
    known=await snapshot();legacy=(await recordReplySuggestion(ws,agent.user.id,tid,'Old suggestion'))!;
    const changed=await snapshot(second,'reply',tid,4000),unrated=await snapshot(),note=await snapshot(agent,'note');
    const boundary=await snapshot();
    await sql`update ai_reply_suggestions set created_at='2026-09-01T00:00:00Z' where workspace_id=${ws}`;
    await sql`update ai_reply_suggestions set created_at='2026-09-03T00:00:00Z' where id=${boundary}`;
    for(const [id,person] of [[known,agent],[changed,second]] as const){
      const res=await post(tid,person,id,id===known?'Original suggestion':'Changed wording');
      expect(res.status).toBe(201);
      const data:any=await res.json();
      await sql`update ticket_messages set created_at='2026-09-01T00:02:00Z' where id=${data.message.id}`;
    }
    await request(`ai/reply-feedback/${known}/shown`,agent,{});
    await request(`ai/reply-feedback/${known}`,agent,{helpful:true});
    await request(`ai/reply-feedback/${changed}`,second,{helpful:false,reason:'wrong_match'});
    await request(`ai/reply-feedback/${legacy}`,agent,{helpful:false});
  },30000);
  afterAll(async()=>{
    if(ws&&other)await sql`delete from workspaces where id in (${ws},${other})`;
    for(const p of [admin,agent,second])if(p)await sql`delete from users where id=${p.user.id}`;
  });
  it('reports exact full-cohort totals, latest ratings, costs and elapsed time',async()=>{
    const res=await report();expect(res.status).toBe(200);const r:any=await res.json();
    expect(r.summary).toMatchObject({generated:4,tracked:3,shown:1,rated:3,helpful:1,not_helpful:2,used:2,changed:1,unchanged:1,cost_known:3,cost_micro:8000,median_seconds:120});
    expect(r.agents.length).toBe(2);expect(r.trend.length).toBe(1);
    expect(r.reasons).toEqual([{reason:'none',count:1},{reason:'wrong_match',count:1}]);
    const old=r.details.find((d:any)=>d.id===legacy);expect(old.reply_context).toBeNull();expect(old.generation_cost_micro).toBeNull();
  });
  it('filters agents, reasons and ratings and exports the same cohort',async()=>{
    const byAgent:any=await (await report({agent:second.user.id})).json();expect(byAgent.summary.generated).toBe(1);
    const negative:any=await (await report({reason:'wrong_match',rating:'not_helpful'})).json();expect(negative.summary.generated).toBe(1);
    const detail:any=await (await report({reason:'wrong_match',rating:'not_helpful',export:'details'})).json();
    expect(detail.summary).toEqual(negative.summary);expect(detail.details).toEqual(negative.details);
    const empty:any=await (await report({agent:'unknown'})).json();expect(empty.summary.generated).toBe(0);expect(empty.summary.median_seconds).toBeNull();
  });
  it('protects admin reports, workspaces and server-owned shown timestamps',async()=>{
    expect((await report({},agent)).status).toBe(403);
    expect((await report({offset:'-1'})).status).toBe(400);
    const foreignReport:any=await (await report({},admin,other)).json();expect(foreignReport.summary.generated).toBe(0);
    expect((await request(`ai/reply-feedback/${known}/shown`,second,{})).status).toBe(200);
    expect((await request(`ai/reply-feedback/${known}/shown`,admin,{},other)).status).toBe(404);
    expect((await request(`ai/reply-feedback/${known}/shown`,agent,{shown_at:'2020-01-01'})).status).toBe(400);
    const [before]=await sql`select shown_at from ai_reply_suggestions where id=${known}`;
    await request(`ai/reply-feedback/${known}/shown`,agent,{});
    const [after]=await sql`select shown_at from ai_reply_suggestions where id=${known}`;expect(after.shown_at).toEqual(before.shown_at);
  });
  it('records only explicit same-ticket public uses and keeps first-use attribution across agents',async()=>{
    const id=await snapshot(),another=await ticket();
    await post(tid,agent);await post(another,agent,id);await post(tid,agent,id,'Note','note');
    expect((await sql`select sent_message_id from ai_reply_suggestions where id=${id}`)[0].sent_message_id).toBeNull();
    const sent:any=await (await post(tid,second,id,' Original   suggestion ')).json();
    const [first]=await sql`select sent_message_id,sent_changed,used_by_user_id from ai_reply_suggestions where id=${id}`;
    expect(first.sent_message_id).toBe(sent.message.id);expect(first.sent_changed).toBe(false);expect(first.used_by_user_id).toBe(second.user.id);
    await post(tid,agent,id,'Another reply');
    expect((await sql`select sent_message_id from ai_reply_suggestions where id=${id}`)[0].sent_message_id).toBe(first.sent_message_id);
    const otherMessage:any=await (await post(tid,agent)).json();
    await recordReplyUse(other,agent.user.id,tid,id,otherMessage.message.id);
    expect((await sql`select sent_message_id from ai_reply_suggestions where id=${id}`)[0].sent_message_id).toBe(first.sent_message_id);
  });
  it('keeps a posted message when optional usage recording fails',async()=>{
    const id=await snapshot();const failing=spyOn(feedback,'recordReplyUse').mockRejectedValue(new Error('unavailable'));
    try {expect((await post(tid,agent,id)).status).toBe(201);}finally{failing.mockRestore();}
  });
  it('reports explicit outcomes and frozen language/category without treating ratings as rejection',async()=>{
    const ids:string[]=[];
    const [category]=await sql`select key from ticket_categories where workspace_id=${ws} limit 1`;
    await sql`update tickets set category_key=${category.key} where id=${tid}`;
    for(let i=0;i<4;i++)ids.push((await recordReplySuggestion(ws,agent.user.id,tid,'Original suggestion',[],{context:'reply',costMicro:1000,language:'French'}))!);
    await sql`update ai_reply_suggestions set created_at='2026-08-01T00:00:00Z' where id=any(${ids}::uuid[])`;
    await sql`update tickets set category_key=null where id=${tid}`;
    expect((await request(`ai/reply-feedback/${ids[0]}/rejected`,second,{rejected:true})).status).toBe(200);
    expect((await request(`ai/reply-feedback/${ids[0]}/rejected`,agent,{rejected:false})).status).toBe(200);
    expect((await request(`ai/reply-feedback/${ids[0]}/rejected`,admin,{rejected:true},other)).status).toBe(404);
    expect((await request(`ai/reply-feedback/${ids[0]}/rejected`,agent,{rejected:true,rejected_at:'2020-01-01'})).status).toBe(400);
    await request(`ai/reply-feedback/${ids[0]}/rejected`,agent,{rejected:true});
    await request(`ai/reply-feedback/${ids[0]}/rejected`,agent,{rejected:false});
    await post(tid,agent,ids[0]);
    await post(tid,agent,ids[1],'Entirely new wording for the customer.');
    await request(`ai/reply-feedback/${ids[2]}/rejected`,agent,{rejected:true});
    await request(`ai/reply-feedback/${ids[3]}`,agent,{helpful:false,reason:'wrong_match'});
    expect((await request(`ai/reply-feedback/${ids[0]}/rejected`,agent,{rejected:true})).status).toBe(404);
    const range={start:'2026-08-01T00:00:00Z',end:'2026-08-02T00:00:00Z'};
    const result:any=await (await report(range)).json();
    expect(result.summary).toMatchObject({generated:4,used:2,substantial:1,rejected:1,change_unavailable:0});
    expect(result.languages[0].reply_language).toBe('French');expect(result.queryTypes[0].query_type).toBe(category.key);
    for(const [outcome,count] of [['accepted',2],['substantial',1],['rejected',1],['unrecorded',1]] as const){
      const filtered:any=await (await report({...range,outcome,language:'French',query_type:category.key})).json();
      expect(filtered.summary.generated).toBe(count);
      const exported:any=await (await report({...range,outcome,language:'French',query_type:category.key,export:'details'})).json();
      expect(exported.details).toEqual(filtered.details);
    }
    await request(`ai/reply-feedback/${ids[2]}/rejected`,agent,{rejected:false});
    expect(((await (await report(range)).json()) as any).summary.rejected).toBe(0);
  });
  it('keeps summary totals independent of detail pagination and rejects oversized exports',async()=>{
    await sql`insert into ai_reply_suggestions(workspace_id,user_id,ticket_id,reply,reply_context,generation_cost_micro,created_at)
      select ${ws},${agent.user.id},${tid},'Synthetic bulk reply','reply',1000,'2026-09-02T00:00:00Z' from generate_series(1,10001)`;
    const page:any=await (await report()).json();const next:any=await (await report({offset:'50'})).json();
    expect(page.summary.generated).toBe(10005);expect(page.details.length).toBe(50);expect(page.hasMore).toBe(true);
    expect(next.summary).toEqual(page.summary);expect(next.details.some((d:any)=>page.details.some((p:any)=>p.id===d.id))).toBe(false);
    expect((await report({export:'details'})).status).toBe(422);
  },30000);
});
