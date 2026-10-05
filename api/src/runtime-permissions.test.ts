import {afterAll,beforeAll,describe,expect,it} from 'bun:test';
import postgres from 'postgres';
import {spawnSync} from 'node:child_process';
import {configureRuntimeAccess} from '../scripts/lib/runtime-access.js';

const run=process.env.RUN_DB_TESTS?describe:describe.skip;
run('restricted database runtime',()=>{
  let owner:ReturnType<typeof postgres>,runtime:ReturnType<typeof postgres>,ws:string,url:URL,customer:string,userId:string;
  const role=`runtime_test_${Date.now()}`;
  beforeAll(async()=>{
    const source=process.env.DATABASE_URL;
    if(!source)throw Error('Synthetic DATABASE_URL is required');
    owner=postgres(source,{max:2,prepare:false,onnotice:()=>{}});
    await owner`create role ${owner(role)} login password 'synthetic-runtime-test-only'`;
    url=new URL(source);url.username=role;url.password='synthetic-runtime-test-only';
    runtime=postgres(url.toString(),{max:2,prepare:false,onnotice:()=>{}});
  });
  afterAll(async()=>{
    if(runtime)await runtime.end();
    if(owner){if(ws)await owner`delete from workspaces where id=${ws}`;
      if(userId)await owner`delete from users where id=${userId}`;
      await owner`drop owned by ${owner(role)}`;await owner`drop role ${owner(role)}`;await owner.end();}
  });
  async function denied(action:()=>PromiseLike<unknown>){let code;try{await action();}catch(e:any){code=e.code;}expect(code).toBe('42501');}
  it('previews without grants and refuses privileged identities',async()=>{
    expect((await configureRuntimeAccess(owner,role,url.pathname.slice(1))).mode).toBe('preview');
    await denied(()=>runtime`select * from public.customers limit 0`);
    let refused=false;try{await configureRuntimeAccess(owner,'postgres',url.pathname.slice(1),true);}catch{refused=true;}
    expect(refused).toBe(true);
  });
  it('supports application writes and governed verification without maintenance powers',async()=>{
    await configureRuntimeAccess(owner,role,url.pathname.slice(1),true);
    const key=crypto.randomUUID();[{id:ws}]=await runtime`select provision_brand(${key},${key}) id`;
    const [c]=await runtime`insert into customers(workspace_id,display_id,first_name) values(${ws},${key},'Synthetic') returning id`;
    customer=c.id;
    const [t]=await runtime`insert into tickets(workspace_id,display_id,customer_id,subject,status_key,priority_key)
      values(${ws},${key},${c.id},'Synthetic','open','normal') returning id`;
    await runtime`insert into events(workspace_id,entity_type,entity_id,kind,author_label,details) values(${ws},'ticket',${t.id},'note','Synthetic','PRIVATE')`;
    await runtime`insert into audit_events(workspace_id,action,target_type,target_id,metadata)
      values(${ws},'ticket.created','ticket',${t.id},'{"subject":"PRIVATE"}')`;
    expect(JSON.stringify(await runtime`select metadata from audit_events where workspace_id=${ws}`)).not.toContain('PRIVATE');
    expect((await runtime`select * from audit_events_verify_checked(true)`).every(r=>r.ok)).toBe(true);
    await runtime`update customers set erased_at=now(),first_name=null where id=${c.id}`;
    expect((await runtime`select details from events where entity_id=${t.id}`)[0].details).toBe('[erased]');
    await denied(()=>runtime`update audit_events set metadata='{}' where workspace_id=${ws}`);
    await denied(()=>runtime`delete from audit_events where workspace_id=${ws}`);
    await denied(()=>runtime`truncate audit_events`);
    await denied(()=>runtime`delete from audit_verify_checkpoints`);
    await denied(()=>runtime`select * from audit_events_verify_incremental()`);
    await denied(()=>runtime`alter table audit_events disable trigger audit_events_no_update`);
    await denied(()=>runtime`create table public.unapproved_runtime_table(id int)`);
    await denied(()=>runtime`create temporary table audit_events(id int)`);
    await denied(()=>runtime`create role unapproved_runtime_role`);
    await denied(()=>runtime`set session_replication_role=replica`);
    await runtime`delete from tickets where id=${t.id}`;
    expect(await runtime`select id from events where entity_id=${t.id}`).toHaveLength(0);
  });
  it('runs authentication, administrator export and erasure through the actual API under the restricted login',()=>{
    const child=spawnSync('node',['--import','tsx','--input-type=module','-e',`
      import assert from 'node:assert/strict';
      globalThis.fetch=async()=>{throw Error('External network disabled');};
      const {auth}=await import('./src/lib/auth.ts');
      const {getDb}=await import('./src/lib/db.ts');
      const {default:app}=await import('./src/index.ts');
      const sql=getDb(),ws=process.env.TEST_WORKSPACE;
      const result=await auth.api.signUpEmail({body:{email:'runtime-'+Date.now()+'@synthetic.test',password:'synthetic-test-password',name:'Synthetic'},returnHeaders:true});
      const {user,token}=result.response;
      await sql\`insert into workspace_members(workspace_id,user_id,role_id,active)
        select \${ws},\${user.id},id,true from roles where workspace_id=\${ws} and is_admin limit 1\`;
      const headers={'Authorization':'Bearer '+token,'X-Workspace-Id':ws,'Content-Type':'application/json'};
      const path='/api/v1/customers/'+process.env.TEST_CUSTOMER;
      assert.equal((await app.request(path+'/export',{headers})).status,200);
      assert.equal((await app.request(path+'/erase',{headers,method:'POST',body:'{}'})).status,200);
      console.log(JSON.stringify({userId:user.id,passed:true}));await sql.end();process.exit(0);
    `],{encoding:'utf8',env:{...process.env,DATABASE_URL:url.toString(),TEST_WORKSPACE:ws,TEST_CUSTOMER:customer,
      POSTMARK_SERVER_TOKEN:'',MAESTRO_API_TOKEN:''},timeout:30000});
    expect(child.status).toBe(0);
    const result=JSON.parse(child.stdout.trim().split('\n').at(-1)??'{}');
    userId=result.userId;expect(result.passed).toBe(true);
  },40000);
  it('checks schema without migration privileges and fails closed for owner or pending migrations',async()=>{
    function boot(databaseUrl:string){return spawnSync('node',['--import','tsx','scripts/migrate.ts'],
      {encoding:'utf8',env:{...process.env,DATABASE_URL:databaseUrl,DATABASE_BOOT_MODE:'check'},timeout:30000});}
    expect(boot(url.toString()).status).toBe(0);
    expect(boot(process.env.DATABASE_URL??'').status).not.toBe(0);
    const [migration]=await owner`select filename from schema_migrations order by filename desc limit 1`;
    await owner`delete from schema_migrations where filename=${migration.filename}`;
    try{expect(boot(url.toString()).status).not.toBe(0);}
    finally{await owner`insert into schema_migrations(filename) values(${migration.filename})`;}
  });
});
