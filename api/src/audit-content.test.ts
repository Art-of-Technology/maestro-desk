import {beforeAll,afterAll,describe,it,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';

const run=process.env.RUN_DB_TESTS?describe:describe.skip;
run('audit minimisation and erasable activity',()=>{
  let sql:ReturnType<typeof import('./lib/db.js').getDb>,ws:string,other:string;
  beforeAll(async()=>{
    sql=(await import('./lib/db.js')).getDb();
    for(const which of ['own','other']) {
      const id=crypto.randomUUID();const [row]=await sql`select provision_brand(${id},${id}) id`;
      if(which==='own')ws=row.id;else other=row.id;
    }
  });
  afterAll(async()=>{for(const id of [ws,other].filter(Boolean))await sql`delete from workspaces where id=${id}`;});
  async function seed(workspace=ws) {
    const id=crypto.randomUUID();
    const [c]=await sql`insert into customers(workspace_id,display_id,first_name) values(${workspace},${id},'Synthetic') returning id`;
    const [t]=await sql`insert into tickets(workspace_id,display_id,customer_id,subject,status_key,priority_key)
      values(${workspace},${id},${c.id},'Synthetic','open','normal') returning id`;
    return {customer:c.id,ticket:t.id};
  }
  async function activity(ticket:string,detail='PRIVATE_ACTIVITY') {
    const {recordTicketActivity,snoozeState}=await import('./lib/ticket-activity.js');
    await sql.begin(async tx=>{
      await tx`select id from tickets where workspace_id=${ws} and id=${ticket} for update`;
      await recordTicketActivity(tx,{workspaceId:ws,ticketId:ticket,actorId:null,kind:'snooze',before:null,
        after:snoozeState({snoozed_until:'2027-01-01T00:00:00Z',snooze_reason:detail})});
    });
  }
  async function erase(customer:string) {
    return (await import('./lib/gdpr-erasure.js')).eraseCustomer({workspaceId:ws,customerId:customer,requestedByUserId:null});
  }
  async function failure(operation:()=>PromiseLike<unknown>) {
    let error:any;try{await operation();}catch(e){error=e;}expect(error).toBeDefined();return error;
  }
  it('keeps useful private history erasable while direct and helper audit writes retain only facts',async()=>{
    const [facts]=await sql`select audit_metadata_facts('ticket.status.changed',
      '{"context":{"reason":"abuse","note":"PRIVATE"},"before":"open","after":"closed"}') value`;
    expect(facts.value).toEqual({context:{reason:'abuse'},before:'open',after:'closed'});
    const s=await seed();await activity(s.ticket);
    const {writeAudit}=await import('./middleware/platform-admin.js');
    await writeAudit({workspaceId:ws,actorUserId:null,action:'ticket.deleted',targetType:'ticket',targetId:s.ticket,
      metadata:{subject:'PRIVATE_SUBJECT',email:'PRIVATE_EMAIL',blank:false}});
    await sql`insert into audit_events(workspace_id,action,target_type,target_id,metadata,actor_ip,actor_ua)
      values(${ws},'portal.ticket_submitted','ticket',${s.ticket},'{"from_name":"PRIVATE_NAME","from_email":"PRIVATE_EMAIL","unknown":{"nested":"PRIVATE"}}','192.0.2.10','PRIVATE_UA')`;
    const rows=await sql`select metadata,actor_ip,actor_ua from audit_events where workspace_id=${ws} and target_id=${s.ticket}`;
    expect(rows).toHaveLength(3);expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    expect(rows.every(r=>r.metadata.customer_id===s.customer)).toBe(true);
    const {exportCustomer}=await import('./lib/gdpr-export.js');
    const bundle=await exportCustomer({workspaceId:ws,customerId:s.customer});
    expect(JSON.stringify(bundle?.activity_history)).toContain('PRIVATE_ACTIVITY');
    expect(bundle?.audit_history).toHaveLength(3);
    await erase(s.customer);await erase(s.customer);
    expect(JSON.stringify((await exportCustomer({workspaceId:ws,customerId:s.customer}))?.activity_history)).not.toContain('PRIVATE');
    expect((await failure(()=>activity(s.ticket,'PRIVATE_LATE'))).constraint_name).toBe('customer_erased');
    expect((await sql`select ok from audit_events_verify(${ws})`)[0].ok).toBe(true);
    expect((await sql`select ok from audit_events_verify_incremental(${ws})`)[0].ok).toBe(true);
  });
  it('retains and discloses legacy audit text without silently rewriting its hash',async()=>{
    const s=await seed(),foreign=await seed(other);
    // Synthetic pre-migration history: keep chain generation/immutability ON.
    await sql.begin(async tx=>{
      await tx`alter table audit_events disable trigger audit_events_00_minimise`;
      await tx`insert into audit_events(workspace_id,action,target_type,target_id,metadata)
        values(${ws},'ticket.deleted','ticket',${s.ticket},'{"subject":"PRIVATE_LEGACY"}'),
          (${other},'ticket.deleted','ticket',${foreign.ticket},'{"subject":"FOREIGN_PRIVATE"}')`;
      await tx`alter table audit_events enable trigger audit_events_00_minimise`;
    });
    const [before]=await sql`select id,encode(row_hash,'hex') hash from audit_events where workspace_id=${ws} and target_id=${s.ticket}`;
    const result=await erase(s.customer);expect(result?.retainedAuditRecords).toBe(1);expect(result?.auditHistoryRequiresReview).toBe(true);
    const bundle=await (await import('./lib/gdpr-export.js')).exportCustomer({workspaceId:ws,customerId:s.customer});
    expect(JSON.stringify(bundle?.audit_history)).toContain('PRIVATE_LEGACY');
    expect(JSON.stringify(bundle)).not.toContain('FOREIGN_PRIVATE');
    expect(bundle?.history_review_notice).toContain('separate search');
    expect((await sql`select encode(row_hash,'hex') hash from audit_events where id=${before.id}`)[0].hash).toBe(before.hash);
    expect((await failure(()=>sql`update audit_events set metadata='{}' where id=${before.id}`)).code).toBe('23514');
    expect((await failure(()=>sql`delete from audit_events where id=${before.id}`)).code).toBe('23514');
    expect((await sql`select ok from audit_events_verify(${ws})`)[0].ok).toBe(true);
  });
  it('preserves existing player audit references through repeated erasure without retaining the player lookup key',async()=>{
    const s=await seed(),foreign=await seed(other),player=crypto.randomUUID();
    await sql`update customers set maestro_user_id=${player} where id in (${s.customer},${foreign.customer})`;
    const rows=await sql`insert into audit_events(workspace_id,action,target_type,target_id,metadata)
      values(${ws},'player.viewed','player',${player},'{"accessed":["contact"]}'),
        (${other},'player.viewed','player',${player},'{"accessed":["balance"]}')
      returning id,workspace_id,encode(row_hash,'hex') hash`;
    const own=rows.find(r=>r.workspace_id===ws);
    if(!own)throw Error('Synthetic player audit was not inserted');
    const {exportCustomer}=await import('./lib/gdpr-export.js');
    expect((await exportCustomer({workspaceId:ws,customerId:s.customer}))?.audit_history.map(r=>r.id)).toEqual([own.id]);
    for(let i=0;i<2;i++) {
      expect((await erase(s.customer))?.retainedAuditRecords).toBe(1);
      expect((await exportCustomer({workspaceId:ws,customerId:s.customer}))?.audit_history.map(r=>r.id)).toEqual([own.id]);
    }
    expect((await sql`select maestro_user_id from customers where id=${s.customer}`)[0].maestro_user_id).toBeNull();
    expect((await sql`select retained_player_audit_ids from gdpr_erasures where customer_id=${s.customer}`)[0].retained_player_audit_ids).toEqual([own.id]);
    expect((await sql`select encode(row_hash,'hex') hash from audit_events where id=${own.id}`)[0].hash).toBe(own.hash);
    expect((await sql`select ok from audit_events_verify(${ws})`)[0].ok).toBe(true);
  });
  it('keeps auto-reply markers on erasure, removes activity on ticket retention, and preserves audit attribution',async()=>{
    const s=await seed();await activity(s.ticket);
    await sql`insert into events(workspace_id,entity_type,entity_id,kind,author_label,details)
      values(${ws},'ticket',${s.ticket},'auto_reply','System','PRIVATE_AUTO')`;
    await erase(s.customer);
    expect(await sql`select id from events where workspace_id=${ws} and entity_id=${s.ticket} and kind='auto_reply'`).toHaveLength(1);
    await sql`delete from tickets where id=${s.ticket} and workspace_id=${ws}`;
    expect(await sql`select id from events where workspace_id=${ws} and entity_id=${s.ticket}`).toHaveLength(0);
    const bundle=await (await import('./lib/gdpr-export.js')).exportCustomer({workspaceId:ws,customerId:s.customer});
    expect(bundle?.audit_history).toHaveLength(1);
    expect((await failure(()=>sql`insert into events(workspace_id,entity_type,entity_id,kind,author_label,details)
      values(${ws},'ticket',${s.ticket},'note','System','PRIVATE_LATE')`)).constraint_name).toBe('customer_erased');
  });
  it('rejects cross-workspace activity and concurrent writes without deadlocking erasure',async()=>{
    const s=await seed(),foreign=await seed(other);
    expect((await failure(()=>activity(foreign.ticket))).constraint_name).toBe('customer_erased');
    let release!:()=>void,ready!:()=>void;
    const pending=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r);
    const owner=sql.begin(async tx=>{await tx`select id from customers where id=${s.customer} for update`;ready();await pending;});
    await started;
    try{expect((await failure(()=>activity(s.ticket))).code).toBe('55P03');}finally{release();await owner;}
    await activity(s.ticket);await erase(s.customer);
    expect((await sql`select details from events where entity_id=${s.ticket}`)[0].details).toBe('[erased]');
    // Reverse order: an accepted activity write holds the customer lock until
    // commit, so erasure cannot overtake it and miss its personal content.
    const next=await seed();
    const written=new Promise<void>(r=>ready=r),finish=new Promise<void>(r=>release=r);
    const writer=sql.begin(async tx=>{
      await tx`insert into events(workspace_id,entity_type,entity_id,kind,author_label,details)
        values(${ws},'ticket',${next.ticket},'note','System','PRIVATE_CONCURRENT')`;
      ready();await finish;
    });
    await written;
    try{expect((await failure(()=>sql.begin(tx=>tx`select id from customers where id=${next.customer} for update nowait`))).code).toBe('55P03');}
    finally{release();await writer;}
    await erase(next.customer);
    expect((await sql`select details from events where entity_id=${next.ticket}`)[0].details).toBe('[erased]');
  });
  it('maps direct legacy reason text to a controlled value and offers a non-mutating inspection',async()=>{
    const s=await seed();await activity(s.ticket);
    await (await import('./lib/gdpr-erasure.js')).eraseCustomer({workspaceId:ws,customerId:s.customer,requestedByUserId:null,reason:'PRIVATE_REASON'});
    expect((await sql`select reason from gdpr_erasures where customer_id=${s.customer}`)[0].reason).toBe('other');
    const before=await sql`select id,encode(row_hash,'hex') hash from audit_events where workspace_id=${ws} order by seq`;
    const child=spawnSync('node',['--import','tsx','scripts/inspect-audit-history.ts','--workspace',ws,'--limit','1'],
      {encoding:'utf8',env:{...process.env,DATABASE_URL:process.env.DATABASE_URL!,POSTMARK_SERVER_TOKEN:'',MAESTRO_API_TOKEN:''},timeout:30000});
    expect(child.status).toBe(0);const report=JSON.parse(child.stdout);
    expect(report.mode).toBe('read_only');expect(report.records).toHaveLength(1);expect(child.stdout).not.toContain('PRIVATE');
    expect([...(await sql`select id,encode(row_hash,'hex') hash from audit_events where workspace_id=${ws} order by seq`)]).toEqual([...before]);
  });
});
