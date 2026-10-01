import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';

const dbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
dbTests('erasure of drafts, custom fields and webhook snapshots', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, foreignWs: string, user: string, field: string, ticketField: string, hook: string;
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    const run = crypto.randomUUID();
    [{ id: ws }] = await sql`select provision_brand(${run},${run}) as id`;
    [{ id: foreignWs }] = await sql`select provision_brand(${run+'-foreign'},${run+'-foreign'}) as id`;
    [{ id: user }] = await sql`insert into users(email,name) values(${run+'@example.test'},'Synthetic privacy test') returning id`;
    [{ id: field }] = await sql`insert into custom_fields(workspace_id,entity_type,key,label,field_type)
      values(${ws},'customer','privacy','Privacy','text') returning id`;
    [{ id: ticketField }] = await sql`insert into custom_fields(workspace_id,entity_type,key,label,field_type)
      values(${ws},'ticket','privacy','Privacy','text') returning id`;
    [{ id: hook }] = await sql`insert into workspace_webhooks(workspace_id,name,url,secret,events)
      values(${ws},'Privacy','https://1.1.1.1/hook','synthetic',array['ticket.created']) returning id`;
  });
  afterAll(async () => {
    if (ws) await sql`delete from workspaces where id in (${ws},${foreignWs})`;
    if (user) await sql`delete from users where id=${user}`;
  });

  async function rejectsErasure(run: () => PromiseLike<unknown>) {
    let failure;
    try { await run(); } catch (error) { failure=error; }
    expect(failure).toMatchObject({constraint_name: 'customer_erased'});
  }
  async function seed(db: typeof sql | TransactionSql = sql) {
    const id = crypto.randomUUID();
    const [c] = await db`insert into customers(workspace_id,display_id,first_name)
      values(${ws},${id},'Synthetic subject') returning id`;
    const [t] = await db`insert into tickets(workspace_id,display_id,customer_id,subject,status_key,priority_key)
      values(${ws},${id},${c.id},'Synthetic personal content','open','normal') returning id`;
    await db`insert into message_drafts(workspace_id,user_id,ticket_id,compose_tab,body,recipients,review)
      values(${ws},${user},${t.id},'reply','private draft','{"to":["synthetic@example.test"]}','{"note":"private review"}')`;
    await db`insert into custom_field_values(workspace_id,field_id,entity_type,entity_id,value) values
      (${ws},${field},'customer',${c.id},'private customer value'),(${ws},${ticketField},'ticket',${t.id},'private ticket value')`;
    const payload = { customer: { id: c.id, email: 'synthetic@example.test' }, ticket: { id: t.id, subject: 'Private subject' } };
    const [d] = await db`insert into webhook_deliveries(workspace_id,webhook_id,event,payload)
      values(${ws},${hook},'ticket.created',${db.json(payload)}) returning id`;
    return { customer: c.id as string, ticket: t.id as string, delivery: d.id as string, payload };
  }
  async function counts(s: Awaited<ReturnType<typeof seed>>, db: typeof sql | TransactionSql = sql) {
    const [row] = await db`select
      (select count(*)::int from message_drafts where workspace_id=${ws} and ticket_id=${s.ticket}) as drafts,
      (select count(*)::int from custom_field_values where workspace_id=${ws} and entity_id in (${s.customer},${s.ticket})) as values,
      (select count(*)::int from webhook_deliveries where id=${s.delivery}) as deliveries`;
    return row;
  }

  it('erases every linked copy, preserves other subjects/workspaces and blocks stale writes', async () => {
    const gone = await seed(), kept = await seed();
    // Deliberately matching identifiers in another workspace must not broaden cleanup.
    const [foreignHook] = await sql`insert into workspace_webhooks(workspace_id,name,url,secret,events)
      values(${foreignWs},'Foreign','https://example.com/hook','synthetic',array['ticket.created']) returning id`;
    const [foreign] = await sql`insert into webhook_deliveries(workspace_id,webhook_id,event,payload)
      values(${foreignWs},${foreignHook.id},'ticket.created',${sql.json(gone.payload)}) returning id`;
    const { eraseCustomer } = await import('./lib/gdpr-erasure.js');
    expect(await eraseCustomer({workspaceId:foreignWs,customerId:gone.customer,requestedByUserId:null})).toBeNull();
    await eraseCustomer({workspaceId:ws,customerId:gone.customer,requestedByUserId:null});
    expect(await counts(gone)).toEqual({drafts:0,values:0,deliveries:0});
    expect(await counts(kept)).toEqual({drafts:1,values:2,deliveries:1});
    expect(await sql`select id from webhook_deliveries where id=${foreign.id}`).toHaveLength(1);
    await rejectsErasure(() => sql`insert into message_drafts(workspace_id,user_id,ticket_id,compose_tab,body)
      values(${ws},${user},${gone.ticket},'reply','stale private draft')`);
    await rejectsErasure(() => sql`insert into custom_field_values(workspace_id,field_id,entity_type,entity_id,value)
      values(${ws},${field},'customer',${gone.customer},'stale value')`);
    await rejectsErasure(() => sql`insert into webhook_deliveries(workspace_id,webhook_id,event,payload)
      values(${ws},${hook},'ticket.created',${sql.json(gone.payload)})`);
  });

  it('migration repairs already-erased records without changing active subjects', async () => {
    // Re-run the real migration inside a rolled-back transaction against pre-fix state.
    const rollback = new Error('rollback migration probe');
    let migrationError;
    try { await sql.begin(async tx => {
      const gone = await seed(tx), kept = await seed(tx);
      await tx`drop trigger customer_erasure_auxiliary on customers`;
      await tx`drop function erase_customer_auxiliary_trigger()`;
      await tx`drop function erase_customer_auxiliary_data(uuid,uuid)`;
      await tx`drop function guard_erased_customer_content() cascade`;
      await tx`update customers set erased_at=now() where id=${gone.customer}`;
      expect(await counts(gone,tx)).toEqual({drafts:1,values:2,deliveries:1});
      await tx.unsafe(readFileSync(new URL('../../db/migrations/20261001140000_erasure_auxiliary_data.sql',import.meta.url),'utf8'));
      expect(await counts(gone,tx)).toEqual({drafts:0,values:0,deliveries:0});
      expect(await counts(kept,tx)).toEqual({drafts:1,values:2,deliveries:1});
      throw rollback;
    }); } catch (error) { migrationError=error; }
    expect(migrationError).toBe(rollback);
  });

  it('serializes draft/custom-value saves and erasure in either order', async () => {
    for (const surface of ['draft','custom']) {
      for (const eraseFirst of [false,true]) {
        const s = await seed();
        let ready!: () => void, release!: () => void;
        const started = new Promise<void>(r => ready=r), gate = new Promise<void>(r => release=r);
        const first = sql.begin(async tx => {
          await tx`select id from customers where id=${s.customer} for update`;
          if (eraseFirst) await tx`update customers set erased_at=now() where id=${s.customer}`;
          else if (surface==='draft') await tx`update message_drafts set body='concurrent private content' where ticket_id=${s.ticket}`;
          else await tx`update custom_field_values set value='concurrent private content' where entity_id=${s.customer}`;
          ready();
          await gate;
        });
        await started;
        let settled = false;
        const second = (eraseFirst
          ? (surface==='draft' ? sql`insert into message_drafts(workspace_id,user_id,ticket_id,compose_tab,body)
              values(${ws},${user},${s.ticket},'note','stale private content')`
            : sql`insert into custom_field_values(workspace_id,field_id,entity_type,entity_id,value)
                values(${ws},${field},'customer',${s.customer},'stale private content')`)
          : sql`update customers set erased_at=now() where id=${s.customer}`)
          .then(() => { settled=true; return null; }, error => { settled=true; return error; });
        try {
          await Bun.sleep(30);
          expect(settled).toBe(false);
        } finally { release(); }
        await first;
        const error = await second;
        if (eraseFirst) expect(error).toMatchObject({constraint_name:'customer_erased'});
        else expect(error).toBeNull();
        expect(await counts(s)).toEqual({drafts:0,values:0,deliveries:0});
      }
      }
  });

  it('waits for an in-flight webhook, then removes it and prevents further delivery', async () => {
    const s = await seed();
    const { processPendingDeliveries } = await import('./lib/outgoing-webhooks.js');
    const { eraseCustomer } = await import('./lib/gdpr-erasure.js');
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>(r => ready=r), gate = new Promise<void>(r => release=r);
    const originalFetch = globalThis.fetch;
    let sends=0, erased=false;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      if (JSON.parse(String(init.body)).ticket?.id===s.ticket) {
        sends++;
        ready();
        await gate;
      }
      return new Response('',{status:200});
    }) as typeof fetch;
    const worker = processPendingDeliveries(100);
    let erasure: ReturnType<typeof eraseCustomer> | undefined;
    try {
      await Promise.race([started,Bun.sleep(2000).then(() => {throw new Error('Webhook never started');})]);
      erasure=eraseCustomer({workspaceId:ws,customerId:s.customer,requestedByUserId:null}).then(r => {erased=true;return r;});
      await Bun.sleep(30);
      expect(erased).toBe(false);
      release();
      await worker;
      await erasure;
      expect(await counts(s)).toEqual({drafts:0,values:0,deliveries:0});
      await processPendingDeliveries(100);
      expect(sends).toBe(1);
    } finally {
      release();
      try { await worker; await erasure; }
      finally { globalThis.fetch=originalFetch; }
    }
  });
});
