// POST /api/v1/tickets — creation contract (Phase 3): display-id allocation,
// default-assignee + rules vs explicit assignee (rules skipped), category
// validation, the post-rules full-row response, and the API-compat
// initial_message behavior.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('ticket create (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const realFetch = globalThis.fetch;

  const RUN = Date.now();
  const admin = { email: `tc-admin-${RUN}@t.test` } as Record<string, string>;
  const agent = { email: `tc-agent-${RUN}@t.test` } as Record<string, string>;
  const outsider = { email: `tc-out-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: email }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(token: string, wsId: string, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-Workspace-Id', wsId);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }
  function create(body: Record<string, unknown>) {
    return as(admin.token, ctx.ws, '/api/v1/tickets', { method: 'POST', body: JSON.stringify(body) });
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();

    const [ua, ug, uo] = await Promise.all([signUp(admin.email), signUp(agent.email), signUp(outsider.email)]);
    admin.userId = ua.id; admin.token = ua.token;
    agent.userId = ug.id; agent.token = ug.token;
    outsider.userId = uo.id;

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'tc-' + RUN}, ${'tc-' + RUN}) as provision_brand`;
    ctx.ws = ws;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    const [plainRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and name = 'Read Only' limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${admin.userId}, ${adminRole.id}, true)`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${agent.userId}, ${plainRole.id}, true)`;
    // outsider deliberately NOT a member.

    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, last_name, email)
      values (${ws}, ${'M-tc-' + RUN}, 'T', 'C', ${`tc-cust-${RUN}@cust.test`})
      returning id
    `;
    ctx.custId = cust.id;

    // An inactive category for the validation matrix.
    await sql`insert into ticket_categories (workspace_id, key, label, is_active) values (${ws}, 'Retired', 'Retired', false)`;
  }, 30000);

  beforeEach(() => {
    // Double cast: the stub omits fetch.preconnect, which the DOM lib now
    // declares on typeof fetch. Nothing under test calls it.
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (ctx.otherWs) await sql`delete from workspaces where id=${ctx.otherWs}`;
    await sql`delete from workspaces where id = ${ctx.ws}`;
    await sql`delete from users where id in (${admin.userId}, ${agent.userId}, ${outsider.userId})`;
  }, 15000);

  it('creates with an allocated display id and returns the full post-rules row', async () => {
    const res = await create({ subject: 'first', customer_id: ctx.custId, category_key: 'Account' });
    expect(res.status).toBe(201);
    const { ticket } = await res.json() as any;
    // Full list-shape row, not the old two-column stub.
    expect(ticket.display_id).toMatch(/^TK-\d+$/);
    expect(ticket.subject).toBe('first');
    expect(ticket.customer_id).toBe(ctx.custId);
    expect(ticket.status_key).toBe('open');
    expect(ticket.priority_key).toBe('normal');
    expect(ticket.category_key).toBe('Account');
    expect(ticket.created_at).toBeDefined();
    expect(ticket.last_message_role).toBeNull();
    // No rules configured → default assignee is the creating agent.
    expect(ticket.assigned_user_id).toBe(admin.userId);
  });

  it('edits and persists a trimmed subject, rejecting invalid subjects and non-members', async () => {
    const created = await create({ subject: 'Original', customer_id: ctx.custId });
    const { ticket } = await created.json() as any;
    const path = `/api/v1/tickets/${ticket.id}`;
    const patch = (subject: unknown, token = admin.token) => as(token, ctx.ws, path, {
      method: 'PATCH', body: JSON.stringify({ subject }),
    });
    const saved = await patch('  Account question  ');
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as any).ticket.subject).toBe('Account question');
    for (const subject of ['', '   ', 'x'.repeat(501), null, 42]) {
      expect((await patch(subject)).status).toBe(400);
    }
    const fetched = await as(admin.token, ctx.ws, path);
    expect(((await fetched.json()) as any).ticket.subject).toBe('Account question');
    const other = await signUp(`tc-subject-out-${RUN}@t.test`);
    try { expect((await patch('Forbidden', other.token)).status).toBe(403); }
    finally { await sql`delete from users where id = ${other.id}`; }
    const [row] = await sql`select subject from tickets where id = ${ticket.id}`;
    expect(row.subject).toBe('Account question');
  });

  it('syncs private drafts with version conflicts, validation, and atomic clearing on send', async () => {
    const created = await create({ subject: 'Draft sync', customer_id: ctx.custId });
    const { ticket } = await created.json() as any;
    const path = `/api/v1/tickets/${ticket.id}`;
    const draftPath = path + '/drafts/reply';
    const put = (body: Record<string, unknown>, token = admin.token, ws = ctx.ws) => as(token, ws, draftPath, {
      method: 'PUT', body: JSON.stringify(body),
    });
    const payload = { version: 0, body: '<p>Hello <strong>there</strong><script>alert(1)</script></p>',
      recipients: { mode: 'reply', to: ['customer@example.test'], cc: 'cc@example.test' }, review: null };
    const first = await put(payload);
    expect(first.status).toBe(200);
    const { draft } = await first.json() as any;
    expect(draft.version).toBe(1);
    expect(draft.body).toContain('<strong>there</strong>');
    expect(draft.body).not.toContain('<script');
    expect(draft.recipients.cc).toBe('cc@example.test');
    expect(((await (await as(admin.token,ctx.ws,draftPath)).json()) as any).draft.body).toBe(draft.body);
    expect(((await (await as(agent.token,ctx.ws,draftPath)).json()) as any).draft.body).toBe('');
    expect((await put(payload)).status).toBe(409);
    expect((await put({ ...payload, version: 1, body: 'x'.repeat(2000001) })).status).toBe(400);
    expect((await put({ ...payload, version: 1 }, admin.token, '00000000-0000-0000-0000-000000000001')).status).not.toBe(200);
    const otherTicket = await create({ subject: 'Other', customer_id: ctx.custId });
    const { ticket: other } = await otherTicket.json() as any;
    const notePath = path + '/drafts/note';
    expect((await as(admin.token,ctx.ws,notePath,{ method:'PUT', body:JSON.stringify({version:0,body:'Private note',recipients:null,review:null}) })).status).toBe(200);
    const send = (version: number, attachment_ids?: string[]) => as(admin.token,ctx.ws,path+'/messages',{
      method:'POST',body:JSON.stringify({role:'agent',body:'Hello there',draft_version:version,attachment_ids}),
    });
    expect((await send(0)).status).toBe(409);
    expect((await send(1, [other.id])).status).toBe(409);
    expect(((await (await as(admin.token,ctx.ws,draftPath)).json()) as any).draft.version).toBe(1);
    const sent = await send(1);
    expect(sent.status).toBe(201);
    expect(((await sent.json()) as any).draft_version).toBe(2);
    const cleared = ((await (await as(admin.token,ctx.ws,draftPath)).json()) as any).draft;
    expect(cleared.body).toBe(''); expect(cleared.recipients).toBeNull();
    expect((await put({ ...payload, version:1 })).status).toBe(409);
    expect((await send(1)).status).toBe(409);
    const [{ count }] = await sql`select count(*)::int as count from ticket_messages where ticket_id=${ticket.id}`;
    expect(count).toBe(1);
    expect(((await (await as(admin.token,ctx.ws,notePath)).json()) as any).draft.body).toBe('Private note');
    expect((await put({version:2,body:'',recipients:null,review:null})).status).toBe(200);
    expect((await put({ ...payload, version:2 })).status).toBe(409);
  });

  it('retains draft files, scopes previews and claims, and releases removed files for cleanup', async () => {
    const {ticket} = await (await create({subject:'Files',customer_id:ctx.custId})).json() as any;
    const path=`/api/v1/tickets/${ticket.id}`, file=crypto.randomUUID(), otherFile=crypto.randomUUID();
    await sql`insert into ticket_attachments(id,workspace_id,ticket_id,filename,size_bytes,storage_key,mime_type,uploaded_by_user_id,created_at)
      values(${file},${ctx.ws},${ticket.id},'receipt.pdf',16,${'draft-test/'+file},'application/pdf',${admin.userId},now()-interval '2 days'),
      (${otherFile},${ctx.ws},${ticket.id},'other.pdf',16,${'draft-test/'+otherFile},'application/pdf',${agent.userId},now())`;
    const put=(version:number,ids:string[])=>as(admin.token,ctx.ws,path+'/drafts/reply',{method:'PUT',body:JSON.stringify({version,body:'Hello',recipients:null,review:null,attachment_ids:ids})});
    expect((await put(0,[otherFile])).status).toBe(400);
    expect((await put(0,[file,file])).status).toBe(400);
    expect((await put(0,[file])).status).toBe(200);
    const oldClient=await as(admin.token,ctx.ws,path+'/drafts/reply',{method:'PUT',body:JSON.stringify({version:1,body:'Edited in an older tab',recipients:null,review:null})});
    expect(oldClient.status).toBe(200);
    expect((await oldClient.json() as any).draft.attachments[0].id).toBe(file);
    const draft=(await (await as(admin.token,ctx.ws,path+'/drafts/reply')).json() as any).draft;
    expect(draft.attachments[0].filename).toBe('receipt.pdf');expect(draft.attachments[0].storage_key).toBeUndefined();
    expect((await as(admin.token,ctx.ws,path+'/attachments/'+file,{method:'DELETE'})).status).toBe(404);
    expect((await as(agent.token,ctx.ws,path+'/attachments/'+file+'/content')).status).toBe(404);
    const [{provision_brand:otherWs}]=await sql`select provision_brand(${'tc-files-'+RUN},${'tc-files-'+RUN})`;
    ctx.otherWs=otherWs;
    const [otherRole]=await sql`select id from roles where workspace_id=${otherWs} and is_admin=true limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${otherWs},${admin.userId},${otherRole.id},true)`;
    expect((await as(admin.token,otherWs,path+'/attachments/'+file+'/content')).status).toBe(404);
    expect((await as(admin.token,otherWs,path+'/drafts/reply')).status).toBe(404);
    expect((await as(admin.token,ctx.ws,path+'/messages',{method:'POST',body:JSON.stringify({role:'note',body:'Cannot steal a file',attachment_ids:[otherFile]})})).status).toBe(400);
    const {sweepUnclaimedAttachments}=await import('./lib/message-attachments.js');
    const store={deleteKeys:async()=>{}} as any;
    await sweepUnclaimedAttachments(24,{store});
    expect((await sql`select id from ticket_attachments where id=${file}`).length).toBe(1);
    const {env}=await import('./lib/env.js');
    const saved={R2_ACCOUNT_ID:env.R2_ACCOUNT_ID,R2_ACCESS_KEY_ID:env.R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY:env.R2_SECRET_ACCESS_KEY,R2_ATTACHMENTS_BUCKET:env.R2_ATTACHMENTS_BUCKET};
    Object.assign(env,{R2_ACCOUNT_ID:'test',R2_ACCESS_KEY_ID:'test',R2_SECRET_ACCESS_KEY:'test',R2_ATTACHMENTS_BUCKET:'test'});
    try {
      globalThis.fetch=(async()=>new Response('%PDF-1.7 sample')) as unknown as typeof fetch;
      const preview=await as(admin.token,ctx.ws,path+'/attachments/'+file+'/content');
      expect(preview.status).toBe(200);expect(preview.headers.get('content-type')).toBe('application/pdf');
      expect(preview.headers.get('cache-control')).toBe('no-store');expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await preview.text()).toBe('%PDF-1.7 sample');
      globalThis.fetch=(async()=>new Response('<script>bad()</script>',{headers:{'Content-Type':'application/pdf'}})) as unknown as typeof fetch;
      const spoof=await as(admin.token,ctx.ws,path+'/attachments/'+file+'/content');
      expect(spoof.headers.get('content-type')).toBe('application/octet-stream');
      globalThis.fetch=(async()=>new Response('missing',{status:404})) as unknown as typeof fetch;
      expect((await as(admin.token,ctx.ws,path+'/attachments/'+file+'/content')).status).toBe(502);
      globalThis.fetch=(async()=>new Response('%PDF-1.7 sample')) as unknown as typeof fetch;
      const savedFile=await as(agent.token,ctx.ws,path+'/drafts/reply',{method:'PUT',body:JSON.stringify({version:0,body:'Reply with file',recipients:null,review:null,attachment_ids:[otherFile]})});
      expect(savedFile.status).toBe(200);
      const sent=await as(agent.token,ctx.ws,path+'/messages',{method:'POST',body:JSON.stringify({role:'agent',body:'Reply with file',draft_version:1,attachment_ids:[otherFile]})});
      expect(sent.status).toBe(201);
      expect((await sent.json() as any).message.attachments[0].id).toBe(otherFile);
      expect((await (await as(agent.token,ctx.ws,path+'/drafts/reply')).json() as any).draft.attachments).toEqual([]);
      expect((await as(admin.token,ctx.ws,path+'/attachments/'+otherFile+'/content')).status).toBe(200);
    } finally {Object.assign(env,saved);}
    expect((await put(2,[])).status).toBe(200);
    expect((await put(2,[file])).status).toBe(409);
    await sweepUnclaimedAttachments(24,{store});
    expect((await sql`select id from ticket_attachments where id=${file}`).length).toBe(0);
    expect((await as(admin.token,ctx.ws,path+'/attachments/'+file+'/content')).status).toBe(404);
    expect((await put(2,[file])).status).toBe(409);
  });

  it('honors an explicit assignee and does NOT run assignment rules over it', async () => {
    // A rule that would grab everything for the admin — the explicit pick
    // must still win because the engine is skipped.
    await sql`
      insert into assign_rules (workspace_id, display_id, name, priority, status, conditions, assignment)
      values (${ctx.ws}, ${'AR-' + RUN}, 'grab-all', 1, 'active',
              ${sql.json({ priority: 'all', category: 'all', vip: 'all' })},
              ${sql.json({ mode: 'specific-agent', agent_user_id: admin.userId })})
    `;
    const res = await create({ subject: 'explicit', customer_id: ctx.custId, assigned_user_id: agent.userId });
    expect(res.status).toBe(201);
    const { ticket } = await res.json() as any;
    expect(ticket.assigned_user_id).toBe(agent.userId);

    // Without an explicit assignee the same rule DOES apply.
    const auto = await create({ subject: 'auto', customer_id: ctx.custId });
    const { ticket: autoT } = await auto.json() as any;
    expect(autoT.assigned_user_id).toBe(admin.userId);
    await sql`delete from assign_rules where workspace_id = ${ctx.ws}`;
  });

  it('rejects a non-member assignee (400)', async () => {
    const res = await create({ subject: 'bad assignee', customer_id: ctx.custId, assigned_user_id: outsider.userId });
    expect(res.status).toBe(400);
  });

  it('category matrix: valid ok · inactive 400 · unknown 400 · omitted ok (null) · case-insensitive canonicalised', async () => {
    expect((await create({ subject: 'c1', customer_id: ctx.custId, category_key: 'Payments' })).status).toBe(201);
    expect((await create({ subject: 'c2', customer_id: ctx.custId, category_key: 'Retired' })).status).toBe(400);
    expect((await create({ subject: 'c3', customer_id: ctx.custId, category_key: 'NoSuchKey' })).status).toBe(400);
    const omitted = await create({ subject: 'c4', customer_id: ctx.custId });
    expect(omitted.status).toBe(201);
    expect(((await omitted.json()) as any).ticket.category_key).toBeNull();
    // Matching is case-insensitive (like the rules engine's catEq) but the
    // stored value is the canonical key, never the caller's casing.
    const lower = await create({ subject: 'c5', customer_id: ctx.custId, category_key: 'payments' });
    expect(lower.status).toBe(201);
    expect(((await lower.json()) as any).ticket.category_key).toBe('Payments');
  });

  it('initial_message regression pin: role customer, author "API caller", not the last word on shape', async () => {
    const res = await create({ subject: 'with msg', customer_id: ctx.custId, initial_message: 'hello from the API' });
    expect(res.status).toBe(201);
    const { ticket } = await res.json() as any;
    const [msg] = await sql<{ role: string; author_label: string; author_user_id: string | null }[]>`
      select role, author_label, author_user_id from ticket_messages where ticket_id = ${ticket.id}
    `;
    expect(msg.role).toBe('customer');
    expect(msg.author_label).toBe('API caller');
    expect(msg.author_user_id).toBeNull();
    expect(ticket.last_message_role).toBe('customer');   // post-insert re-select sees it
  });

  it('player-lookup shape pin: ticket.display_id present in the envelope', async () => {
    const res = await create({ subject: 'shape', customer_id: ctx.custId });
    const body = await res.json() as any;
    expect(typeof body.ticket.display_id).toBe('string');   // startConversation reads exactly this
  });
});
