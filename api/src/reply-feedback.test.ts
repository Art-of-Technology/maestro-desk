import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { recordReplySuggestion } from './lib/reply-feedback.js';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('reply feedback', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, other: string, admin: any, agent: any, second: any;
  const run = crypto.randomUUID();
  const request = (path: string, token: string, body?: unknown, workspace = ws) => app.request('/api/v1/ai/reply-feedback' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function ticket(workspace = ws) {
    const id = crypto.randomUUID();
    const [c] = await sql`insert into customers(workspace_id,display_id,first_name) values (${workspace},${id},'Test') returning id`;
    const [t] = await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
      values (${workspace},${id},'Test question',${c.id},'open','normal') returning id`;
    const [m] = await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body)
      values (${workspace},${t.id},'agent','Test','Previous reply') returning id`;
    return { id: t.id as string, customer: c.id as string, message: m.id as string };
  }
  async function suggestion(withSource = false) {
    const target = await ticket(), source = withSource ? await ticket() : null;
    const id = await recordReplySuggestion(ws, agent.user.id, target.id, 'Original suggestion', source
      ? [{ id: source.id, title: 'Source', question:'Question',reply:'Previous reply',questionId:source.message,replyId:source.message }] : []);
    return { id: id!, target, source };
  }
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    [admin,agent,second] = await Promise.all(['admin','agent','second'].map(key => auth.api.signUpEmail({body:{email:`feedback-${key}-${run}@t.test`,password:'test-password-12345',name:'Test'}})));
    [ws,other] = await Promise.all(['a','b'].map(async key => (await sql`select provision_brand('Feedback test',${'feedback-' + key + run}) as id`)[0].id));
    for (const person of [admin,agent,second]) {
      const [role] = await sql`select id from roles where workspace_id=${ws} and is_admin=${person === admin} limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${ws},${person.user.id},${role.id},true)`;
    }
    const [role] = await sql`select id from roles where workspace_id=${other} and is_admin=true limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${other},${admin.user.id},${role.id},true)`;
  });
  afterAll(async () => {
    if (ws && other) await sql`delete from workspaces where id in (${ws},${other})`;
    for (const p of [admin,agent,second]) if(p) await sql`delete from users where id=${p.user.id}`;
  });
  it('keeps one editable rating, leaves the original suggestion and messages unchanged', async () => {
    const {id,target} = await suggestion(true);
    expect((await request('/'+id,agent.token,{helpful:false,reason:'wrong_match'})).status).toBe(200);
    expect((await request('/'+id,agent.token,{helpful:false,reason:'wrong_match'})).status).toBe(200);
    expect((await sql`select * from ai_reply_feedback where suggestion_id=${id}`).length).toBe(1);
    let data: any = await (await request('',admin.token)).json();
    expect(data.items.find((r:any)=>r.id===id).sources.length).toBe(1);
    expect(data.items.find((r:any)=>r.id===id).reply).toBe('Original suggestion');
    expect((await request('/'+id,agent.token,{helpful:true})).status).toBe(200);
    data = await (await request('',admin.token)).json();
    expect(data.items.some((r:any)=>r.id===id)).toBe(false);
    expect((await sql`select body from ticket_messages where ticket_id=${target.id}`)[0].body).toBe('Previous reply');
  });
  it('lets workspace agents rate shared suggestions while workspace admins alone can read reports', async () => {
    const {id} = await suggestion();
    expect((await request('/'+id,second.token,{helpful:false})).status).toBe(200);
    expect((await request('/'+id,admin.token,{helpful:false},other)).status).toBe(404);
    expect((await request('',agent.token)).status).toBe(403);
    expect((await request('/'+id,agent.token,{helpful:false,user_id:admin.user.id})).status).toBe(400);
    expect((await request('/'+id,agent.token,{helpful:true,reason:'wrong_language'})).status).toBe(400);
    expect((await request('/bad-id',agent.token,{helpful:false})).status).toBe(400);
    expect((await request('?offset=-1',admin.token)).status).toBe(400);
    await request('/'+id,agent.token,{helpful:false});
    expect(((await (await request('',admin.token,undefined,other)).json()) as any).items).toEqual([]);
    const foreign = await ticket(other);
    expect(await recordReplySuggestion(ws,agent.user.id,foreign.id,'No')).toBeNull();
  });
  it('shares, versions, retains and transfers an AI reply draft between agents',async()=>{
    const target=await ticket();
    const id=await recordReplySuggestion(ws,agent.user.id,target.id,'Shared answer',[],{context:'reply',costMicro:1,
      review:{references:[],notes:['Verify the account.']}});
    const ticketRequest=(token:string,method='GET',body?:unknown,workspace=ws)=>app.request(`/api/v1/tickets/${target.id}${method==='PATCH'?'/ai-draft':''}`,{
      method,headers:{Authorization:`Bearer ${token}`,'X-Workspace-Id':workspace,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
    let detail:any=await (await ticketRequest(second.token)).json();
    expect(detail.ticket.ai_reply_draft.draft_body).toBe('Shared answer');
    expect(detail.ticket.ai_reply_draft.draft_review.notes).toEqual(['Verify the account.']);
    const edit={suggestion_id:id,version:0,body:'Tailored answer',body_html:'<p>Tailored <strong>answer</strong></p>'};
    expect((await ticketRequest(second.token,'PATCH',edit)).status).toBe(200);
    expect((await ticketRequest(agent.token,'PATCH',edit)).status).toBe(409);
    await sql`update tickets set status_key='pending' where id=${target.id}`;
    detail=await (await ticketRequest(agent.token)).json();
    expect(detail.ticket.ai_reply_draft.draft_body).toContain('Tailored');
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body) values (${ws},${target.id},'customer','Customer','One more detail')`;
    detail=await (await ticketRequest(second.token)).json();
    expect(detail.ticket.ai_reply_draft.stale).toBe(true);
    expect((await ticketRequest(admin.token,'GET',undefined,other)).status).toBe(404);
    expect((await request('/'+id+'/rejected',second.token,{rejected:true})).status).toBe(200);
    detail=await (await ticketRequest(agent.token)).json();
    expect(detail.ticket.ai_reply_draft.rejected_at).toBeTruthy();
    expect((await ticketRequest(agent.token,'PATCH',{...edit,version:2})).status).toBe(409);
    expect((await request('/'+id+'/rejected',agent.token,{rejected:false})).status).toBe(200);
    const sent=await app.request(`/api/v1/tickets/${target.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${second.token}`,'X-Workspace-Id':ws,'Content-Type':'application/json'},
      body:JSON.stringify({role:'agent',body:'Tailored answer',reply_suggestion_id:id})});
    expect(sent.status).toBe(201);
    expect((await sql`select used_by_user_id from ai_reply_suggestions where id=${id}`)[0].used_by_user_id).toBe(second.user.id);
    detail=await (await ticketRequest(agent.token)).json();
    expect(detail.ticket.ai_reply_draft).toBeNull();
  });
  it('purges feedback and snapshots for target erasure, source erasure and ticket removal', async () => {
    for (const mode of ['target','source','delete','soft-delete','move']) {
      const {id,target,source} = await suggestion(true);
      await request('/'+id,agent.token,{helpful:false});
      if (mode==='target' || mode==='source') await sql`update customers set erased_at=now() where id=${mode==='target' ? target.customer : source!.customer}`;
      if (mode==='delete') await sql`delete from tickets where id=${source!.id}`;
      if (mode==='soft-delete') await sql`update tickets set deleted_at=now() where id=${target.id}`;
      if (mode==='move') await sql`update tickets set customer_id=${source!.customer} where id=${target.id}`;
      expect((await sql`select id from ai_reply_suggestions where id=${id}`).length).toBe(0);
      expect((await sql`select * from ai_reply_feedback where suggestion_id=${id}`).length).toBe(0);
      expect((await request('/'+id,agent.token,{helpful:true})).status).toBe(404);
    }
  });
  it('does not retain a suggestion generated while its customer was erased', async () => {
    const t = await ticket();
    await sql`update customers set erased_at=now() where id=${t.customer}`;
    expect(await recordReplySuggestion(ws,agent.user.id,t.id,'Late suggestion')).toBeNull();
  });
  it('paginates negative feedback without exposing helpful ratings', async () => {
    const t = await ticket();
    for(let n=0;n<27;n++) {
      const id = await recordReplySuggestion(ws,agent.user.id,t.id,`Suggestion ${n}`);
      await sql`insert into ai_reply_feedback(suggestion_id,helpful) values (${id},false)`;
    }
    const first:any = await (await request('',admin.token)).json();
    const next:any = await (await request('?offset=25',admin.token)).json();
    expect(first.items.length).toBe(25); expect(first.hasMore).toBe(true);
    expect(next.items.length).toBeGreaterThan(0);
    expect(next.items.some((x:any)=>first.items.some((y:any)=>y.id===x.id))).toBe(false);
  });
  it('scopes resolution changes, validates owners, and protects concurrent updates', async () => {
    const {id}=await suggestion();
    await request('/'+id,agent.token,{helpful:false,reason:'wrong_match'});
    const patch=(body:unknown,token=admin.token,workspace=ws)=>app.request(`/api/v1/ai/reply-feedback/${id}/resolution`,{
      method:'PATCH',headers:{Authorization:`Bearer ${token}`,'X-Workspace-Id':workspace,'Content-Type':'application/json'},body:JSON.stringify(body),
    });
    const body={status:'in_progress',owner_user_id:second.user.id,root_cause:'wrong_match',notes:'Checking the example match.',version:0};
    expect((await patch(body,agent.token)).status).toBe(403);
    expect((await patch(body,admin.token,other)).status).toBe(404);
    expect((await patch({...body,owner_user_id:crypto.randomUUID()})).status).toBe(400);
    await sql`update workspace_members set active=false where workspace_id=${ws} and user_id=${second.user.id}`;
    const [foreignRole]=await sql`select id from roles where workspace_id=${other} and not is_admin limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${other},${second.user.id},${foreignRole.id},true)`;
    expect((await patch(body)).status).toBe(400);
    await sql`update workspace_members set active=true where workspace_id=${ws} and user_id=${second.user.id}`;
    expect((await patch(body)).status).toBe(200);
    expect((await patch(body)).status).toBe(409);
    const progress:any=await (await request('?status=in_progress',admin.token)).json();
    expect(progress.items.find((r:any)=>r.id===id).owner_user_id).toBe(second.user.id);
    expect(progress.owners.some((r:any)=>r.id===second.user.id)).toBe(true);
    expect((await patch({...body,status:'resolved',notes:'',version:1})).status).toBe(400);
    expect((await patch({...body,status:'resolved',root_cause:null,version:1})).status).toBe(400);
    expect((await patch({...body,status:'resolved',notes:'Corrected the matching guidance.',version:1})).status).toBe(200);
    const resolved:any=await (await request('?status=resolved',admin.token)).json();
    expect(resolved.items.find((r:any)=>r.id===id).resolution_version).toBe(2);
    expect(resolved.items.find((r:any)=>r.id===id).resolution_updated_at).toBeTruthy();
    expect(((await (await request('',admin.token)).json()) as any).items.some((r:any)=>r.id===id)).toBe(false);
    const [stored]=await sql`select resolution_updated_by from ai_reply_feedback where suggestion_id=${id}`;
    expect(stored.resolution_updated_by).toBe(admin.user.id);
    // Corrected agent feedback reopens a resolved issue; repeated identical ratings do not.
    await request('/'+id,agent.token,{helpful:false,reason:'wrong_match'});
    expect((await sql`select resolution_status from ai_reply_feedback where suggestion_id=${id}`)[0].resolution_status).toBe('resolved');
    await request('/'+id,agent.token,{helpful:false,reason:'wrong_language'});
    expect((await sql`select resolution_status from ai_reply_feedback where suggestion_id=${id}`)[0].resolution_status).toBe('open');
    expect((await patch({...body,version:2})).status).toBe(409);
    expect((await request('?status=invalid',admin.token)).status).toBe(400);
  });
});
