import { afterEach, describe, expect, it } from 'bun:test';
import { matchReceipt, reconcileTk133, sends } from '../scripts/reconcile-tk133-email.js';

const recipient = 'synthetic@example.test';
function fixture(index: number) {
  const send = sends[index], body = `Synthetic reply ${index}`, html = `<p>${body}</p>`;
  const details = {MessageID:send.providerId,Subject:'Re: (no subject)',From:'Support <support@example.test>',
    ReceivedAt:new Date(Date.parse(send.createdAt)+500).toISOString(),Sandboxed:false,MessageStream:'outbound',
    TextBody:`header\n${body}\nfooter`,HtmlBody:`<main>${html}</main>`,To:[{Email:recipient}],Cc:[],Bcc:[],
    MessageEvents:[{Type:'Delivered',Recipient:recipient,ReceivedAt:new Date(Date.parse(send.createdAt)+1000).toISOString()}]};
  const message = {body,body_html:html,external_message_id:null,email_metadata:{status:'saved',from:'support@example.test',to:[recipient],cc:[]},
    sent_email:index === 1 ? {subject:details.Subject,text:details.TextBody,html:details.HtmlBody,logo_url:null} : null};
  return {message,details,dump:{Body:`Message-ID: <synthetic-${index}@example.test>\r\n\r\ncontent`}};
}

it('matches exact saved email or the complete legacy reply and rejects conflicting evidence', () => {
  for (const index of [0,1]) {
    const f=fixture(index);
    expect(matchReceipt(f.message,f.details,f.dump,sends[index]).alreadyRepaired).toBe(false);
    for (const patch of [{MessageID:crypto.randomUUID()},{Sandboxed:true},{Bcc:[{Email:recipient}]},
      {To:[{Email:'different@example.test'}]},{TextBody:'different content'},{ReceivedAt:'2020-01-01T00:00:00Z'},
      {MessageEvents:[]},{MessageEvents:[...f.details.MessageEvents,{Type:'Bounced',Recipient:recipient,ReceivedAt:f.details.ReceivedAt}]}]) {
      expect(()=>matchReceipt(f.message,{...f.details,...patch},f.dump,sends[index])).toThrow();
    }
    expect(()=>matchReceipt(f.message,f.details,{Body:'Message-ID: invalid\r\n\r\ncontent'},sends[index])).toThrow();
    expect(()=>matchReceipt(f.message,f.details,{Body:'Message-ID: <one@example.test>\nMessage-ID: <two@example.test>\n\ncontent'},sends[index])).toThrow();
  }
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('TK-133 guarded repair (DB-backed)',()=>{
  let ws: string | undefined;
  afterEach(async()=>{if(ws){await (await import('./lib/db.js')).getDb()`delete from workspaces where id=${ws}`;ws=undefined;}});
  async function seed() {
    const sql=(await import('./lib/db.js')).getDb();
    [{id:ws}]=await sql`select provision_brand('Synthetic repair test','spacecasino') as id`;
    const [customer]=await sql`insert into customers(workspace_id,display_id,first_name,email)
      values(${ws!},'M76','Synthetic',${recipient}) returning id`;
    const [ticket]=await sql`insert into tickets(workspace_id,display_id,customer_id,subject,status_key,priority_key)
      values(${ws!},'TK-133',${customer.id},'(no subject)','open','normal') returning id`;
    for (let i=0;i<2;i++) {
      const m=fixture(i).message;
      await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,body_html,email_metadata,sent_email,created_at)
        values(${ws!},${ticket.id},'agent','Synthetic operator',${m.body},${m.body_html},${sql.json(m.email_metadata)},${m.sent_email ? sql.json(m.sent_email) : null},${sends[i].createdAt})`;
    }
    const read=()=>sql`select external_message_id,email_metadata,body,sent_email from ticket_messages where workspace_id=${ws!} and ticket_id=${ticket.id} order by created_at`;
    const fetchProvider=async(id:string)=>fixture(sends.findIndex(s=>s.providerId===id));
    return {sql,ticket,customer,read,fetchProvider};
  }
  it('defaults to dry run, applies exactly two rows, keeps recovery metadata and is idempotent',async()=>{
    const f=await seed(),before=await f.read();
    const preview=await reconcileTk133(f.sql,f.fetchProvider);
    expect(preview.mode).toBe('dry-run');
    expect(await f.read()).toEqual(before);
    await expect(reconcileTk133(f.sql,f.fetchProvider,true)).rejects.toThrow('confirmation is missing');
    expect((await reconcileTk133(f.sql,f.fetchProvider,true,preview.snapshotHash)).rows).toHaveLength(2);
    const after=await f.read();
    for(let i=0;i<2;i++) {
      expect(after[i].email_metadata.status).toBe('sent');
      expect(after[i].email_metadata.delivered_recipients[recipient]).toBe(fixture(i).details.MessageEvents[0].ReceivedAt);
      expect(after[i].email_metadata.delivery_repair.previous_email_metadata).toEqual(before[i].email_metadata);
      expect(after[i].external_message_id).toBe(`<synthetic-${i}@example.test>`);
      expect(after[i].body).toBe(before[i].body);expect(after[i].sent_email).toEqual(before[i].sent_email);
    }
    expect((await reconcileTk133(f.sql,f.fetchProvider,true)).rows.every(r=>r.alreadyRepaired)).toBe(true);
    expect(await f.read()).toEqual(after);
  });
  it('refuses both writes if the second receipt mismatches, and rejects erased customers',async()=>{
    const f=await seed(),before=await f.read();
    await expect(reconcileTk133(f.sql,async id=>{const data=await f.fetchProvider(id);if(id===sends[1].providerId)data.details.HtmlBody='wrong';return data;},true)).rejects.toThrow();
    expect(await f.read()).toEqual(before);
    await f.sql`update customers set erased_at=now() where workspace_id=${ws!} and id=${f.customer.id}`;
    await expect(reconcileTk133(f.sql,f.fetchProvider,true)).rejects.toThrow('Approved ticket is unavailable');
    expect(await f.read()).toEqual(before);
  });
  it('rolls back the first update when the second database write fails',async()=>{
    const f=await seed(),before=await f.read();
    const preview=await reconcileTk133(f.sql,f.fetchProvider);
    await f.sql.unsafe(`create function reject_synthetic_repair() returns trigger language plpgsql as $$ begin
      if new.created_at='2026-10-16T16:29:01.247Z'::timestamptz and new.email_metadata->>'status'='sent' then raise exception 'synthetic write failure'; end if; return new; end $$;
      create trigger reject_synthetic_repair before update on ticket_messages for each row execute function reject_synthetic_repair()`);
    try {
      await expect(reconcileTk133(f.sql,f.fetchProvider,true,preview.snapshotHash)).rejects.toThrow('synthetic write failure');
      expect(await f.read()).toEqual(before);
    } finally {await f.sql.unsafe('drop trigger reject_synthetic_repair on ticket_messages; drop function reject_synthetic_repair()');}
  });
  it('refuses a changed snapshot after preview, even when email content still matches',async()=>{
    const f=await seed(),preview=await reconcileTk133(f.sql,f.fetchProvider);
    await f.sql`update ticket_messages set email_metadata=email_metadata || '{"operator_note":"changed"}'::jsonb where workspace_id=${ws!}`;
    await expect(reconcileTk133(f.sql,f.fetchProvider,true,preview.snapshotHash)).rejects.toThrow('snapshot changed');
    const rows=await f.read();expect(rows.every(r=>r.email_metadata.status==='saved')).toBe(true);
  });
});
