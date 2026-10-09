import {beforeAll,beforeEach,afterEach,afterAll,describe,it,expect,spyOn} from 'bun:test';
import * as r2 from './lib/r2.js';

(process.env.RUN_DB_TESTS?describe:describe.skip)('forward ticket emails',()=>{
  let sql:ReturnType<typeof import('./lib/db.js').getDb>, app:typeof import('./index.js').default;
  let ws:string, otherWs:string, user:string, token:string, customer:string, ticket:string, message:string, slug:string;
  let storage:ReturnType<typeof spyOn>, calls:any[]=[], failure=false, gate:Promise<void>|null=null;
  const objects=new Map<string,Uint8Array>();
  const originalFetch=globalThis.fetch;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=','base64');
  const store:r2.R2Store={
    getObject:async key=>{if(!objects.has(key))throw Error('Missing object');return {bytes:objects.get(key)!,contentType:null};},
    putObject:async(key,bytes)=>{objects.set(key,bytes);},deleteKeys:async keys=>{keys.forEach(k=>objects.delete(k));},
    listKeys:async()=>[...objects.keys()],presignGet:async()=> 'https://files.example.test/signed',
  };
  function request(path:string,body?:unknown,workspace=ws){return app.request(`/api/v1/tickets/${path}`,{
    method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'X-Workspace-Id':workspace,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
  const endpoint=()=>`${ticket}/emails/${message}/forward`;
  async function input(extra:Record<string,unknown>={}){
    const res=await request(endpoint()); expect(res.status).toBe(200);
    const preview=await res.json() as any;
    return {request_id:crypto.randomUUID(),source_version:preview.source_version,to:['supplier@example.test'],cc:[],subject:preview.subject,
      message:'Please investigate.',attachment_ids:preview.attachments.map((a:any)=>a.id),sending_channel_id:null,sending_address:null,...extra};
  }
  async function seedTicket(workspace=ws){
    const id=crypto.randomUUID();
    const [c]=await sql`insert into customers(workspace_id,display_id,first_name,email) values(${workspace},${id},'Customer',${id+'@customer.test'}) returning id`;
    const [t]=await sql`insert into tickets(workspace_id,display_id,customer_id,subject,status_key,priority_key) values(${workspace},${id},${c.id},'Original subject','open','normal') returning id`;
    return {customer:c.id as string,ticket:t.id as string};
  }
  async function attachment(inline=false){
    const id=crypto.randomUUID(), key='synthetic/'+id;
    const bytes=inline?png:Buffer.from('Original attachment'); objects.set(key,bytes);
    await sql`insert into ticket_attachments(id,workspace_id,ticket_id,message_id,filename,storage_key,size_bytes,mime_type,is_inline,disposition)
      values(${id},${ws},${ticket},${message},${inline?'logo.png':'receipt.txt'},${key},${bytes.length},${inline?'image/png':'text/plain'},${inline},${inline?'inline':'attachment'})`;
    if(inline)await sql`update ticket_messages set body_html=${`<h1 style="color:blue">Original header</h1><img src="cid:${id}"><footer>Original footer</footer><script>bad()</script>`} where id=${message}`;
    return {id,key};
  }
  beforeAll(async()=>{
    app=(await import('./index.js')).default;sql=(await import('./lib/db.js')).getDb();
    slug='forward-'+crypto.randomUUID();
    const signed:any=await (await import('./lib/auth.js')).auth.api.signUpEmail({body:{email:slug+'@example.test',name:'Forward agent',password:'forward-test-password'}});
    user=signed.user.id;token=signed.token;
    [{id:ws}]=await sql`select provision_brand(${slug},${slug}) as id`;
    [{id:otherWs}]=await sql`select provision_brand(${slug+'-other'},${slug+'-other'}) as id`;
    const [role]=await sql`select id from roles where workspace_id=${ws} and is_admin=true limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${ws},${user},${role.id},true)`;
  },30000);
  beforeEach(async()=>{
    ({customer,ticket}=await seedTicket());
    [{id:message}]=await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,body_html,external_message_id,email_metadata)
      values(${ws},${ticket},'customer','Customer','Original body','<p>Original body</p>',${'<'+crypto.randomUUID()+'@example.test>'},${sql.json({status:'received',from:'customer@example.test',to:['support@example.test'],received_at:'2026-10-01T10:00:00Z'})}) returning id`;
    await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body) values(${ws},${ticket},'note','Agent','SECRET INTERNAL NOTE')`;
    await sql`delete from rate_limit_hits where bucket like ${'ticket-forward:'+ws+':%'}`;
    calls=[];failure=false;gate=null;objects.clear();
    storage=spyOn(r2,'attachmentsStore').mockReturnValue(store);
    globalThis.fetch=(async(input: any,init:any)=>{
      if(String(input).startsWith('https://api.postmarkapp.com/email')){
        calls.push(JSON.parse(init.body)); if(gate)await gate;
        if(failure)throw Error('Uncertain transport failure');
        return new Response(JSON.stringify({MessageID:'forward-synthetic',SubmittedAt:'2026-10-09T10:00:00Z',ErrorCode:0,Message:'OK'}),{status:200});
      }
      return originalFetch(input,init);
    }) as typeof fetch;
  });
  afterEach(()=>{storage.mockRestore();globalThis.fetch=originalFetch;});
  afterAll(async()=>{if(ws)await sql`delete from workspaces where id in (${ws},${otherWs})`;if(user)await sql`delete from users where id=${user}`;});
  it('forwards saved formatting and selected attachments to new recipients, once, without changing replies or exposing the forward in the portal',async()=>{
    const image=await attachment(true);await attachment();
    const before=await (await import('./lib/email-recipients.js')).ticketReplyRecipients(ws,ticket);
    const data=await input({attachment_ids:[image.id],cc:['copy@example.test']});
    const res=await request(endpoint(),data);expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);expect(calls[0].To).toBe('supplier@example.test');expect(calls[0].Cc).toBe('copy@example.test');
    expect(calls[0].Subject).toBe('Fwd: Original subject');
    for(const text of ['Please investigate.','Original header','Original footer'])expect(calls[0].HtmlBody).toContain(text);
    expect(calls[0].HtmlBody).not.toContain('bad()');expect(calls[0].HtmlBody).not.toContain('SECRET');
    expect(calls[0].Attachments).toHaveLength(1);expect(calls[0].HtmlBody).toContain(calls[0].Attachments[0].ContentID);
    expect(calls[0].Headers.some((h:any)=>h.Name==='In-Reply-To')).toBe(false);
    expect((await request(endpoint(),data)).status).toBe(200);expect(calls).toHaveLength(1);
    const [row]=await sql`select sent_email,forwarded_from_ticket_ids,email_metadata from ticket_messages where id=${data.request_id}`;
    expect(row.sent_email.html).toBe(calls[0].HtmlBody);expect(row.forwarded_from_ticket_ids).toEqual([ticket]);expect(row.email_metadata.status).toBe('sent');
    const [copy]=await sql`select id,storage_key from ticket_attachments where message_id=${data.request_id}`;
    expect(copy.id).not.toBe(image.id);expect(objects.has(copy.storage_key)).toBe(true);expect(objects.has(image.key)).toBe(true);
    expect((await (await import('./lib/email-recipients.js')).ticketReplyRecipients(ws,ticket)).to).toEqual(before.to);
    const auth=await import('./lib/portal-auth.js');
    const link=await auth.createMagicLink({workspaceId:ws,customerId:customer});
    const session=await auth.verifyMagicLink({workspaceId:ws,token:link.token});
    const portalToken=session!.sessionToken;
    const [t]=await sql`select display_id from tickets where id=${ticket}`;
    const portal=await app.request(`/api/v1/public/${slug}/customer/tickets/${t.display_id}`,{headers:{Authorization:`Bearer ${portalToken}`}});
    expect(portal.status).toBe(200);expect(await portal.text()).not.toContain('Please investigate.');
  });
  it('rejects notes, foreign tickets/files, invalid recipients, changed content and erased owners',async()=>{
    const data=await input();
    const [note]=await sql`select id from ticket_messages where ticket_id=${ticket} and role='note'`;
    expect((await request(`${ticket}/emails/${note.id}/forward`)).status).toBe(404);
    expect((await request(endpoint(),data,otherWs)).status).toBe(403);
    const other=await seedTicket();expect((await request(`${other.ticket}/emails/${message}/forward`,data)).status).toBe(404);
    expect((await request(endpoint(),{...data,to:['bad\r\nBcc: hacked@example.test']})).status).toBe(400);
    expect((await request(endpoint(),{...data,attachment_ids:[crypto.randomUUID()]})).status).toBe(400);
    await sql`update ticket_messages set body='Changed' where id=${message}`;
    expect((await request(endpoint(),data)).status).toBe(409);
    await sql`update customers set erased_at=now() where id=${customer}`;
    expect((await request(endpoint(),data)).status).toBe(404);expect(calls).toHaveLength(0);
  });
  it('keeps uncertain delivery from being sent twice',async()=>{
    const data=await input();failure=true;
    expect((await request(endpoint(),data)).status).toBe(502);
    expect((await request(endpoint(),data)).status).toBe(409);expect(calls).toHaveLength(1);
    expect((await sql`select email_metadata from ticket_messages where id=${data.request_id}`)[0].email_metadata.forward_state).toBe('unknown');
  });
  it('does not send a partial email when an included attachment is missing',async()=>{
    const a=await attachment();const data=await input();objects.delete(a.key);
    const res=await request(endpoint(),data);expect(res.status).toBe(503);expect((await res.json() as any).retryable).toBe(true);expect(calls).toHaveLength(0);
  });
  it('blocks concurrent submissions with the same request ID',async()=>{
    let release!:()=>void;gate=new Promise<void>(r=>{release=r;});const data=await input();
    const first=request(endpoint(),data);
    while(!calls.length)await new Promise(r=>setTimeout(r,5));
    try{expect((await request(endpoint(),data)).status).toBe(409);}finally{release();}
    expect((await first).status).toBe(201);expect(calls).toHaveLength(1);
  });
  it('rechecks access and source content after copying attachments',async()=>{
    const file=await attachment();
    for(const change of ['membership','source'] as const){
      const data=await input();
      const put=spyOn(store,'putObject').mockImplementation(async(key,bytes)=>{
        objects.set(key,bytes);
        if(change==='membership')await sql`update workspace_members set active=false where workspace_id=${ws} and user_id=${user}`;
        else await sql`update ticket_messages set deleted_at=now() where id=${message}`;
      });
      try {
        const res=await request(endpoint(),data);
        expect(res.status).toBeGreaterThanOrEqual(400);expect(calls).toHaveLength(0);
        expect(await sql`select id from ticket_attachments where message_id=${data.request_id}`).toHaveLength(0);
        expect(objects.has(file.key)).toBe(true);
      } finally {
        put.mockRestore();
        await sql`update workspace_members set active=true where workspace_id=${ws} and user_id=${user}`;
        await sql`update ticket_messages set deleted_at=null where id=${message}`;
      }
    }
  });
  it('rejects suppressed recipients, receiving inboxes, unverified senders and oversized selections',async()=>{
    const file=await attachment();const data=await input();
    await sql`insert into customers(workspace_id,display_id,email,email_bounce_state) values(${ws},${crypto.randomUUID()},'blocked@example.test','hard')`;
    expect((await request(endpoint(),{...data,to:['blocked@example.test']})).status).toBe(422);
    expect((await request(endpoint(),{...data,to:['support@maestro.test']})).status).toBe(400);
    expect((await request(endpoint(),{...data,sending_channel_id:crypto.randomUUID(),sending_address:'fake@example.test'})).status).toBe(409);
    await sql`update ticket_attachments set size_bytes=8000000 where id=${file.id}`;
    expect((await request(endpoint(),await input())).status).toBe(413);expect(calls).toHaveLength(0);
  });
  it('resolves merged originals and erases forwarded copies and copied objects with their source customer',async()=>{
    const originalTicket=ticket,originalCustomer=customer;const a=await attachment();
    const target=await seedTicket();ticket=target.ticket;
    const [copy]=await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,email_metadata,merged_from_id)
      select workspace_id,${ticket},role,author_label,body,email_metadata,${originalTicket} from ticket_messages where id=${message} returning id`;
    message=copy.id;
    await sql`update tickets set merged_into_id=${ticket} where id=${originalTicket}`;
    const data=await input();expect((await request(endpoint(),data)).status).toBe(201);
    const [copied]=await sql`select storage_key from ticket_attachments where message_id=${data.request_id}`;
    const destination=await seedTicket();
    const [mergedForward]=await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,merged_from_id,forwarded_from_ticket_ids)
      select workspace_id,${destination.ticket},role,author_label,body,${ticket},forwarded_from_ticket_ids from ticket_messages where id=${data.request_id} returning id`;
    const {exportCustomer}=await import('./lib/gdpr-export.js');
    const exported=await exportCustomer({workspaceId:ws,customerId:originalCustomer});
    expect(exported!.tickets.flatMap(t=>t.messages).filter(m=>String(m.body).includes('Please investigate.'))).toHaveLength(2);
    await (await import('./lib/gdpr-erasure.js')).eraseCustomer({workspaceId:ws,customerId:originalCustomer,requestedByUserId:user},{deleteObjects:store.deleteKeys});
    expect(await sql`select id from ticket_messages where id=${data.request_id}`).toHaveLength(0);
    expect(await sql`select id from ticket_messages where id=${mergedForward.id}`).toHaveLength(0);
    expect(objects.has(copied.storage_key)).toBe(false);expect(objects.has(a.key)).toBe(false);
    expect((await sql`select erased_at from customers where id=${target.customer}`)[0].erased_at).toBeNull();
  });
});
