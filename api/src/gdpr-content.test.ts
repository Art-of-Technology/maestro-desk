import { beforeAll, afterAll, describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';

const dbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
dbTests('customer content erasure and late work', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>, ws: string, user: string;
  beforeAll(async () => {
    sql=(await import('./lib/db.js')).getDb();
    const run=crypto.randomUUID();
    [{id:ws}]=await sql`select provision_brand(${run},${run}) as id`;
    [{id:user}]=await sql`insert into users(email,name) values(${run+'@example.test'},'Synthetic privacy agent') returning id`;
    await sql`update workspaces set ai_credits_micro=10000000,auto_reply_min_confidence=null,ai_player_enrichment=false where id=${ws}`;
  });
  afterAll(async () => { if(ws)await sql`delete from workspaces where id=${ws}`;if(user)await sql`delete from users where id=${user}`; });
  async function seed() {
    const id=crypto.randomUUID();
    const [c]=await sql`insert into customers(workspace_id,display_id,first_name) values(${ws},${id},'Synthetic subject') returning id`;
    const [t]=await sql`insert into tickets(workspace_id,display_id,customer_id,subject,status_key,priority_key,ai_summary,ai_draft_reply)
      values(${ws},${id},${c.id},'private subject','open','normal','{"text":"PRIVATE_SUMMARY"}','{"text":"PRIVATE_DRAFT"}') returning id`;
    return {customer:c.id as string,ticket:t.id as string};
  }
  async function erase(s: Awaited<ReturnType<typeof seed>>) {
    return (await import('./lib/gdpr-erasure.js')).eraseCustomer({workspaceId:ws,customerId:s.customer,requestedByUserId:user});
  }
  it('exports retained content for review, erases it, and allows harmless repeated erasure',async()=>{
    const s=await seed(),other=await seed();
    const [m]=await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,deleted_at)
      values(${ws},${s.ticket},'note','Agent','PRIVATE_DELETED_NOTE',now()) returning id`;
    await sql`insert into reply_internal_reviews(workspace_id,message_id,review) values(${ws},${m.id},'{"note":"PRIVATE_REVIEW"}')`;
    await sql`insert into ai_reply_suggestions(workspace_id,ticket_id,user_id,reply,draft_body)
      values(${ws},${s.ticket},${user},'PRIVATE_SUGGESTION','PRIVATE_SHARED_DRAFT')`;
    await sql`insert into time_entries(workspace_id,ticket_id,user_id,minutes,note) values(${ws},${s.ticket},${user},2,'PRIVATE_TIME')`;
    await sql`insert into ticket_tags(workspace_id,ticket_id,tag) values(${ws},${s.ticket},'PRIVATE_TAG')`;
    const {exportCustomer}=await import('./lib/gdpr-export.js');
    const bundle=JSON.stringify(await exportCustomer({workspaceId:ws,customerId:s.customer}));
    for(const marker of ['PRIVATE_SUMMARY','PRIVATE_DRAFT','PRIVATE_DELETED_NOTE','PRIVATE_REVIEW','PRIVATE_SUGGESTION','PRIVATE_SHARED_DRAFT','PRIVATE_TIME','PRIVATE_TAG'])expect(bundle).toContain(marker);
    await erase(s);expect((await erase(s))?.alreadyErased).toBe(true);
    const clean=JSON.stringify(await exportCustomer({workspaceId:ws,customerId:s.customer}));
    expect(clean).not.toContain('PRIVATE_');
    expect((await sql`select ai_summary from tickets where id=${other.ticket}`)[0].ai_summary.text).toBe('PRIVATE_SUMMARY');
    expect((await sql`select id from gdpr_erasures where customer_id=${s.customer}`).length).toBe(1);
  });
  it('removes attributable merge copies without erasing the destination owner',async()=>{
    const s=await seed(),target=await seed();
    const {ticketPrivacy,requireTicketPrivacy}=await import('./lib/ticket-privacy.js');
    const snapshot=await ticketPrivacy(ws,[target.ticket]); 
    const [copy]=await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,merged_from_id)
      values(${ws},${target.ticket},'customer','PRIVATE_SOURCE','PRIVATE_COPY',${s.ticket}) returning id`;
    await sql`insert into reply_internal_reviews(workspace_id,message_id,review) values(${ws},${copy.id},'{"note":"PRIVATE_COPIED_REVIEW"}')`;
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body)
      values(${ws},${target.ticket},'customer','Other','OTHER_CONTENT')`;
    await sql`insert into customer_notes(workspace_id,customer_id,author_user_id,text,merged_from_customer_id)
      values(${ws},${target.customer},${user},'PRIVATE_MOVED_NOTE',${s.customer})`;
    await erase(s);
    expect(await sql`select id from ticket_messages where id=${copy.id}`).toHaveLength(0);
    expect(await sql`select id from ticket_messages where ticket_id=${target.ticket} and body='OTHER_CONTENT'`).toHaveLength(1);
    expect((await sql`select erased_at from customers where id=${target.customer}`)[0].erased_at).toBeNull();
    expect((await sql`select ai_summary from tickets where id=${target.ticket}`)[0].ai_summary).toBeNull();
    expect(await sql`select id from customer_notes where workspace_id=${ws} and merged_from_customer_id=${s.customer}`).toHaveLength(0);
    let rejected=false;try{await requireTicketPrivacy(ws,snapshot);}catch{rejected=true;}expect(rejected).toBe(true); 
  });
  it('clears a third-party email envelope on legacy erased-subject copies without allowing content changes',async()=>{
    const origin=await seed(),target=await seed(),subject=await seed();
    const email=crypto.randomUUID()+'@example.test';
    await sql`update customers set email=${email} where id=${subject.customer}`;
    await erase(origin);
    // Reproduce a copied message left by a pre-guard erasure, only in this test transaction.
    const [copy]=await sql.begin(async tx=>{
      await tx`set local session_replication_role='replica'`;
      return tx`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,body_html,merged_from_id,email_metadata)
        values(${ws},${target.ticket},'customer','Legacy author','LEGACY_COPY','<p>LEGACY_COPY</p>',${origin.ticket},${tx.json({cc:email})}) returning id`;
    });
    await erase(subject);
    const [retained]=await sql`select body,body_html,author_label,email_metadata,ticket_id,merged_from_id from ticket_messages where id=${copy.id}`;
    expect(retained).toMatchObject({body:'LEGACY_COPY',body_html:'<p>LEGACY_COPY</p>',author_label:'Legacy author',email_metadata:null,ticket_id:target.ticket,merged_from_id:origin.ticket});
    expect((await sql`select erased_at from customers where id=${subject.customer}`)[0].erased_at).not.toBeNull();
    for(const write of [
      ()=>sql`update ticket_messages set email_metadata=null,body='RESTORED' where id=${copy.id}`,
      ()=>sql`update ticket_messages set email_metadata=null,body_html='<p>RESTORED</p>' where id=${copy.id}`,
      ()=>sql`update ticket_messages set email_metadata=null,author_label='RESTORED' where id=${copy.id}`,
      ()=>sql`update ticket_messages set email_metadata=null,ticket_id=${origin.ticket} where id=${copy.id}`,
      ()=>sql`update ticket_messages set email_metadata=${sql.json({cc:email})} where id=${copy.id}`,
      ()=>sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,merged_from_id)
        values(${ws},${target.ticket},'customer','New copy','RESTORED',${origin.ticket})`,
    ]) { let error:any;try{await write();}catch(e){error=e;}expect(error?.constraint_name).toBe('customer_erased'); }
  });
  it('rejects stale SQL writes across affected surfaces',async()=>{
    const s=await seed();await erase(s);
    for(const write of [
      ()=>sql`update tickets set ai_summary='{"text":"LATE"}' where id=${s.ticket}`,
      ()=>sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body) values(${ws},${s.ticket},'note','Agent','LATE')`,
      ()=>sql`insert into time_entries(workspace_id,ticket_id,user_id,minutes,note) values(${ws},${s.ticket},${user},1,'LATE')`,
      ()=>sql`insert into ticket_ai_tags(workspace_id,ticket_id,tag,confidence) values(${ws},${s.ticket},'LATE',80)`,
      ()=>sql`insert into customer_notes(workspace_id,customer_id,author_user_id,text) values(${ws},${s.customer},${user},'LATE')`,
    ]){let error:any;try{await write();}catch(e){error=e;}expect(error?.constraint_name).toBe('customer_erased');}
  });
  it('returns not-sent results for erased or missing tickets without contacting email providers',async()=>{
    const s=await seed();await erase(s);
    const {sendAgentReplyEmail}=await import('./lib/agent-reply.js');
    const {postAutoReply}=await import('./lib/auto-reply.js');
    const {sendCsatSurvey}=await import('./lib/csat-survey.js');
    const {notifyMentionedAgents}=await import('./lib/mention-notify.js');
    const original=globalThis.fetch;let calls=0;
    globalThis.fetch=Object.assign(async()=>{calls++;throw new Error('External calls forbidden');},{preconnect:original.preconnect});
    try {
      for(const ticketId of [s.ticket,crypto.randomUUID()]) {
        const common={workspaceId:ws,ticketId};
        expect(await sendAgentReplyEmail({...common,messageId:crypto.randomUUID(),authorUserId:user,body:'STALE'})).toMatchObject({emailed:false,reason:'send_failed'});
        expect(await postAutoReply({...common,draftReply:'STALE',confidence:90,model:'synthetic',workspaceName:'Test'})).toMatchObject({posted:false,reason:'send_failed'});
        expect(await sendCsatSurvey(common)).toMatchObject({sent:false,reason:'send_failed'});
        expect(await notifyMentionedAgents({...common,authorUserId:null,authorLabel:'Test',mentions:[user],body:'STALE'})).toEqual({sent:0,skipped:1});
      }
      expect(calls).toBe(0);
    } finally {globalThis.fetch=original;}
  });
  it('exports transferred history but refuses ambiguous erasure of a deleted merged source or its survivor',async()=>{
    const source=await seed(),survivor=await seed();
    await sql`update tickets set customer_id=${survivor.customer},pre_merge_customer_id=${source.customer} where id=${source.ticket}`;
    await sql`update customers set merged_into_customer_id=${survivor.customer},deleted_at=now() where id=${source.customer}`;
    const {exportCustomer}=await import('./lib/gdpr-export.js');
    expect((await exportCustomer({workspaceId:ws,customerId:source.customer}))?.tickets).toHaveLength(1);
    for(const subject of [source,survivor]) {
      let error:any;try{await erase(subject);}catch(e){error=e;}expect(error?.status).toBe(409);
      expect((await sql`select erased_at from customers where id=${subject.customer}`)[0].erased_at).toBeNull();
    }
    expect((await sql`select ai_summary from tickets where id=${source.ticket}`)[0].ai_summary.text).toBe('PRIVATE_SUMMARY');
  });
  it('discards real triage completion after erasure and refuses a new generation',async()=>{
    const s=await seed();
    const {anthropic}=await import('./lib/anthropic.js');const original=anthropic.messages.create;
    let release!:()=>void, started!:()=>void, calls=0;
    const pending=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
    anthropic.messages.create=(async()=>{calls++;started();await pending;return {id:'synthetic',usage:{input_tokens:1,output_tokens:1},content:[{type:'tool_use',name:'record_triage',input:{category_key:'general',priority_key:'normal',sentiment:'neutral',summary:'LATE',draft_reply:'LATE',tags:[{tag:'LATE',confidence:80}],confidence:80}}]};}) as any;
    try {
      const {triageTicket}=await import('./lib/triage.js');
      const job=triageTicket({workspaceId:ws,ticketId:s.ticket,userId:user}).then(()=>false,()=>true);
      await ready;await erase(s);release();expect(await job).toBe(true);
      await expect(triageTicket({workspaceId:ws,ticketId:s.ticket,userId:user})).rejects.toThrow();expect(calls).toBe(1);
      expect((await sql`select ai_summary,ai_draft_reply from tickets where id=${s.ticket}`)[0]).toMatchObject({ai_summary:null,ai_draft_reply:null});
      expect(await sql`select tag from ticket_ai_tags where ticket_id=${s.ticket}`).toHaveLength(0);
    } finally {release();anthropic.messages.create=original;}
  });
  it('waits for a started bounded send, and prevents any later send',async()=>{
    const s=await seed();const {ticketPrivacy}=await import('./lib/ticket-privacy.js');
    const {sendWhileWorkspaceAvailable}=await import('./lib/workspace-access.js');
    const privacy=await ticketPrivacy(ws,[s.ticket]);let release!:()=>void,started!:()=>void;
    const pending=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
    let sent=0,erased=false;
    const send=sendWhileWorkspaceAvailable(ws,async()=>{started();await pending;sent++;},undefined,privacy);
    await ready;const erasure=erase(s).then(()=>{erased=true;});
    try {await new Promise(r=>setTimeout(r,30));expect(erased).toBe(false);} finally {release();}
    await send;await erasure;
    let rejected=false;try{await sendWhileWorkspaceAvailable(ws,async()=>{sent++;},undefined,privacy);}catch{rejected=true;}expect(rejected).toBe(true);expect(sent).toBe(1);
  });
  it('fails a reversed lock order promptly instead of deadlocking erasure',async()=>{
    const s=await seed();let release!:()=>void,started!:()=>void;
    const pending=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
    const eraser=sql.begin(async tx=>{await tx`select id from customers where id=${s.customer} for update`;started();await pending;});
    await ready;
    try {
      let error:any;
      try{await sql`update tickets set ai_summary='{"text":"LATE"}' where id=${s.ticket}`;}catch(e){error=e;}
      expect(error?.code).toBe('55P03');
    } finally {release();await eraser;}
  });
  it('previews historical omissions without changes and applies an explicitly confirmed bounded repair',async()=>{
    const s=await seed();await erase(s);
    // Emulate pre-migration data locally; no table-wide trigger disabling.
    await sql.begin(async tx=>{
      await tx`set local session_replication_role='replica'`;
      await tx`update tickets set ai_summary='{"text":"HISTORICAL_PRIVATE"}' where id=${s.ticket}`;
    });
    const run=(args:string[])=>spawnSync('node',['--import','tsx','scripts/repair-erased-content.ts','--workspace',ws,...args],{
      cwd:import.meta.dirname+'/..',encoding:'utf8',timeout:15000,
      env:{...process.env,DATABASE_URL:process.env.DATABASE_URL!,POSTMARK_SERVER_TOKEN:'',MAESTRO_API_TOKEN:'',ALERT_EMAIL_TO:'',SLACK_ALERT_WEBHOOK_URL:''},
    });
    const preview=run([]);expect(preview.status).toBe(0);expect(preview.stdout).toContain('"mode":"preview"');expect(preview.stdout).not.toContain('HISTORICAL_PRIVATE');
    expect((await sql`select ai_summary from tickets where id=${s.ticket}`)[0].ai_summary.text).toBe('HISTORICAL_PRIVATE');
    expect(run(['--apply']).status).not.toBe(0);
    const applied=run(['--apply','--confirm',ws]);expect(applied.status).toBe(0);expect(applied.stdout).toContain('"mode":"applied"');
    expect((await sql`select ai_summary from tickets where id=${s.ticket}`)[0].ai_summary).toBeNull();
    expect((await sql`select id from gdpr_erasures where customer_id=${s.customer}`).length).toBe(1);
  });
  it('discards workspace-wide and ticket assistant responses after erasure while settling paid usage',async()=>{
    const {auth}=await import('./lib/auth.js');const app=(await import('./index.js')).default;
    const signed=await auth.api.signUpEmail({body:{email:crypto.randomUUID()+'@example.test',password:'synthetic-test-password',name:'Synthetic AI tester'}});
    const [role]=await sql`select id from roles where workspace_id=${ws} and is_admin=true limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${ws},${signed.user.id},${role.id},true)`;
    const {anthropic}=await import('./lib/anthropic.js');const original=anthropic.messages.create;
    try {
      for(const withTicket of [false,true]) {
        const s=await seed();let release!:()=>void,started!:()=>void;
        const pending=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
        anthropic.messages.create=(async()=>{started();await pending;return {id:'synthetic-erasure',usage:{input_tokens:20,output_tokens:8},content:[{type:'text',text:'STALE_PERSONAL'}]};}) as any;
        const response=app.request('/api/v1/ai/messages',{method:'POST',headers:{Authorization:`Bearer ${signed.token}`,'X-Workspace-Id':ws,'Content-Type':'application/json'},
          body:JSON.stringify({action:'chat',...(withTicket?{ticketId:s.ticket}:{}),sources:['tickets'],messages:[{role:'user',content:'Summarize the ticket.'}],maxTokens:100})});
        await ready;await erase(s);release();const result=await response;
        expect(result.status).toBe(409);expect(await result.text()).not.toContain('STALE_PERSONAL');
        const [balance]=await sql`select ai_reserved_micro from workspaces where id=${ws}`;
        expect(Number(balance.ai_reserved_micro)).toBe(0);
      }
      const [usage]=await sql`select count(*)::int as n from ai_usage_log where workspace_id=${ws} and request_id='synthetic-erasure' and cost_usd_micro>0`;
      expect(usage.n).toBe(2);
    } finally {anthropic.messages.create=original;await sql`delete from users where id=${signed.user.id}`;}
  });
});
