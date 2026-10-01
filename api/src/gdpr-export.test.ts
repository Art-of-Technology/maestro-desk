// GDPR data-subject export — DB-backed integration test (RUN_DB_TESTS, same
// harness as tenant-isolation / gdpr-erasure). Seeds a customer with data across
// every surface, calls GET /api/v1/customers/:id/export, asserts the bundle is
// complete + admin-gated.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('GDPR export (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const slug = `exp-${RUN}`;
  const admin = { email: `exp-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `exp-agent-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;
  let hasLegacyKyc = false;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({
      body: { email, password: 'password-12345', name: email },
      returnHeaders: true,
    });
    return { id: r.response.user.id, token: r.response.token };
  }

  function as(token: string | null, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', ctx.wsId);
    return app.request(path, { ...init, headers });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug] = await Promise.all([signUp(admin.email), signUp(agent.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;

    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${slug}, ${slug}) as provision_brand
    `;
    ctx.wsId = wsId;

    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and is_admin = true limit 1`;
    const [roRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and coalesce(is_admin,false) = false limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${agent.userId}, ${roRole.id}, true)`;

    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, last_name, email, mobile, jurisdiction)
      values (${wsId}, ${'M-' + slug}, 'Jane', 'Doe', ${'jane-' + slug + '@player.test'}, '+15551234', 'MT')
      returning id
    `;
    ctx.customerId = cust.id;
    const [shape] = await sql`select to_jsonb(customers) ? 'kyc_status' as present from customers where id = ${cust.id}`;
    hasLegacyKyc = shape.present;
    if (hasLegacyKyc) await sql`update customers set kyc_status = 'verified' where id = ${cust.id}`;

    const [tk] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${wsId}, ${'TK-' + slug}, 'Withdrawal help', ${cust.id}, 'open', 'normal')
      returning id
    `;
    ctx.ticketId = tk.id;
    for(const type of ['customer','ticket']) {
      const [f]=await sql`insert into custom_fields(workspace_id,entity_type,key,label,field_type)
        values(${wsId},${type},'privacy_export','Review details','text') returning id`;
      await sql`insert into custom_field_values(workspace_id,field_id,entity_type,entity_id,value)
        values(${wsId},${f.id},${type},${type==='customer'?cust.id:tk.id},${type+' personal value'})`;
    }
    await sql`insert into message_drafts(workspace_id,user_id,ticket_id,compose_tab,body,recipients,review) values
      (${wsId},${admin.userId},${tk.id},'reply','Unsent reply','{"to":["jane@example.test"]}','{"notes":["Review context"]}'),
      (${wsId},${agent.userId},${tk.id},'note','Unsent note',null,null)`;
    const [other]=await sql`insert into customers(workspace_id,display_id,first_name)
      values(${wsId},'M-other','OTHER_CUSTOMER_PRIVATE') returning id`;
    const [otherTicket]=await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key)
      values(${wsId},'TK-other','OTHER_CUSTOMER_PRIVATE',${other.id},'open','normal') returning id`;
    await sql`insert into message_drafts(workspace_id,user_id,ticket_id,compose_tab,body)
      values(${wsId},${admin.userId},${otherTicket.id},'reply','OTHER_CUSTOMER_PRIVATE')`;
    const [{id:foreignWs}]=await sql`select provision_brand(${slug+'-other'},${slug+'-other'}) as id`;
    ctx.foreignWs=foreignWs;
    const [foreign]=await sql`insert into customers(workspace_id,display_id,first_name)
      values(${foreignWs},'M-foreign','FOREIGN_PRIVATE') returning id`;
    ctx.foreignCustomer=foreign.id;

    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body) values (${wsId}, ${tk.id}, 'customer', 'Jane Doe', 'Where is my withdrawal?')`;
    await sql`insert into customer_notes (workspace_id, customer_id, text) values (${wsId}, ${cust.id}, 'Patient VIP')`;
    // Contacts model: primary + secondary address — both belong in the bundle.
    await sql`
      insert into customer_contacts (workspace_id, customer_id, kind, value, is_primary) values
        (${wsId}, ${cust.id}, 'email', ${'jane-' + slug + '@player.test'}, true),
        (${wsId}, ${cust.id}, 'email', ${'jane-alt-' + slug + '@player.test'}, false)
    `;

    const [ch] = await sql<{ id: string }[]>`insert into channels (workspace_id, display_id, name, type) values (${wsId}, ${'CH-' + slug}, 'Inbox', 'email') returning id`;
    await sql`
      insert into inbox_messages (workspace_id, channel_id, from_name, from_email, subject, body, received_at, converted_ticket_id)
      values (${wsId}, ${ch.id}, 'Jane Doe', ${'jane-' + slug + '@player.test'}, 'Withdrawal', 'help please', now(), ${tk.id})
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    if (ctx.wsId) await sql`delete from workspaces where id in (${ctx.wsId},${ctx.foreignWs})`;
    const ids = [admin.userId, agent.userId].filter(Boolean);
    if (ids.length) await sql`delete from users where id in ${sql(ids)}`;
  });

  it('non-admin members are refused (403)', async () => {
    const res = await as(agent.token, `/api/v1/customers/${ctx.customerId}/export`);
    expect(res.status).toBe(403);
  });

  it('404s an unknown customer id', async () => {
    const res = await as(admin.token, `/api/v1/customers/00000000-0000-0000-0000-000000000000/export`);
    expect(res.status).toBe(404);
  });

  it('returns an admin review bundle with drafts and custom fields as a download', async () => {
    const res = await as(admin.token, `/api/v1/customers/${ctx.customerId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body: any = await res.json();

    expect(body.customer.email).toBe(`jane-${slug}@player.test`);
    expect(body.customer.first_name).toBe('Jane');
    expect(body.customer.display_id).toBe('M-' + slug);
    expect(body.customer.id).toBeUndefined(); // internal uuid stripped
    if (hasLegacyKyc) expect(body.customer.kyc_status).toBe('verified');
    else expect(body.customer).not.toHaveProperty('kyc_status');
    expect(body.customer).not.toHaveProperty('has_legacy_kyc');

    expect(body.review_required).toBe(true);
    expect(body.attachment_contents_included).toBe(false);
    expect(body.custom_fields[0]).toMatchObject({key:'privacy_export',value:'customer personal value'});
    expect(body.tickets[0].custom_fields[0]).toMatchObject({value:'ticket personal value'});
    expect(body.tickets[0].drafts.map((d:any)=>d.body).sort()).toEqual(['Unsent note','Unsent reply']);
    expect(body.tickets[0].drafts.find((d:any)=>d.compose_tab==='reply').review.notes).toEqual(['Review context']);
    expect(JSON.stringify(body)).not.toContain('OTHER_CUSTOMER_PRIVATE');
    expect(JSON.stringify(body)).not.toContain('FOREIGN_PRIVATE');
    expect(body.notes.length).toBe(1);
    expect(body.notes[0].text).toBe('Patient VIP');

    expect(body.contacts.length).toBe(2);
    expect(body.contacts.find((c: any) => c.is_primary).value).toBe(`jane-${slug}@player.test`);
    expect(body.contacts.map((c: any) => c.value)).toContain(`jane-alt-${slug}@player.test`);

    expect(body.tickets.length).toBe(1);
    expect(body.tickets[0].subject).toBe('Withdrawal help');
    expect(body.tickets[0].messages.length).toBe(1);
    expect(body.tickets[0].messages[0].body).toBe('Where is my withdrawal?');

    expect(body.inbox_messages.length).toBeGreaterThanOrEqual(1);
    expect(body.inbox_messages[0].from_email).toBe(`jane-${slug}@player.test`);

    expect(typeof body.exported_at).toBe('string');
    expect(body.workspace.slug).toBe(slug);     // provenance, not internal uuid
    expect((body as any).workspace_id).toBeUndefined();
  });

  it('refuses a customer from another workspace',async()=>{
    expect((await as(admin.token,`/api/v1/customers/${ctx.foreignCustomer}/export`)).status).toBe(404);
    expect((await as(admin.token,`/api/v1/customers/${ctx.foreignCustomer}/erase`,{method:'POST',body:'{}'})).status).toBe(404);
    const [kept]=await sql`select first_name,erased_at from customers where id=${ctx.foreignCustomer}`;
    expect(kept.first_name).toBe('FOREIGN_PRIVATE');expect(kept.erased_at).toBeNull();
  });

  it('exports draft attachment metadata without storage keys or file contents',async()=>{
    const [a]=await sql`insert into ticket_attachments(workspace_id,ticket_id,filename,storage_key,mime_type)
      values(${ctx.wsId},${ctx.ticketId},'private.pdf','DO_NOT_EXPORT_STORAGE_KEY','application/pdf') returning id`;
    try {
      await sql`update message_drafts set attachment_ids=array[${a.id}::uuid] where ticket_id=${ctx.ticketId} and compose_tab='reply'`;
      const res=await as(admin.token,`/api/v1/customers/${ctx.customerId}/export`);const body:any=await res.json();
      expect(body.tickets[0].drafts.find((d:any)=>d.compose_tab==='reply').attachments[0].filename).toBe('private.pdf');
      expect(JSON.stringify(body)).not.toContain('DO_NOT_EXPORT_STORAGE_KEY');
    } finally {await sql`delete from ticket_attachments where id=${a.id}`;}
  });

  it('returns 410 Gone once the customer has been erased', async () => {
    const erase = await as(admin.token, `/api/v1/customers/${ctx.customerId}/erase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(erase.status).toBe(200);
    const res = await as(admin.token, `/api/v1/customers/${ctx.customerId}/export`);
    expect(res.status).toBe(410);
  });
});
