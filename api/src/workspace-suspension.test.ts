import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const dbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
dbTests('workspace suspension', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let ws: string, user: string, token: string, brand: string, ticket: string, attachment: string;
  const key = `test-suspension-${crypto.randomUUID()}.png`;
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const signed = await auth.api.signUpEmail({ body: { email: `suspension-${crypto.randomUUID()}@example.test`, name: 'Operator', password: 'Operator-password-123!' } });
    user = signed.user.id; token = signed.token!;
    await sql`update users set is_platform_admin=true where id=${user}`;
    [{ id: ws }] = await sql`select provision_brand(${`suspension-${crypto.randomUUID()}`},'Suspension test') as id`;
    brand = crypto.randomUUID();
    await sql`update workspaces set maestro_brand_id=${brand},ai_credits_micro=1000000 where id=${ws}`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active)
      select ${ws},${user},id,true from roles where workspace_id=${ws} and is_admin`;
    const [customer] = await sql`insert into customers(workspace_id,display_id,first_name,email)
      values (${ws},'SUSP-C1','Synthetic','synthetic@example.test') returning id`;
    [{ id: ticket }] = await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key)
      values (${ws},${customer.id},'SUSP-1','Private file','open','normal') returning id`;
    const [msg] = await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body)
      values (${ws},${ticket},'customer','Synthetic','Synthetic message') returning id`;
    [{ id: attachment }] = await sql`insert into ticket_attachments(workspace_id,ticket_id,message_id,filename,storage_key,size_bytes,mime_type)
      values (${ws},${ticket},${msg.id},'test.png',${key},8,'image/png') returning id`;
  });
  afterAll(async () => {
    if (ws) await sql`delete from workspaces where id=${ws}`;
    if (user) await sql`delete from users where id=${user}`;
  });
  const headers = () => ({ Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json' });
  const suspend = async (value: 'now' | null) => app.request(`/api/v1/god/brands/${ws}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ suspended_at: value }),
  });

  it('blocks existing sessions, player access and sending while preserving operator recovery', async () => {
    const { agentBrandWorkspaceId, maestroBrandIdForWorkspace } = await import('./lib/maestro-workspace.js');
    const { assertHasBudget } = await import('./lib/budget.js');
    const { workspaceAccessGeneration, sendWhileWorkspaceAvailable } = await import('./lib/workspace-access.js');
    expect((await app.request('/api/v1/tickets', { headers: headers() })).status).toBe(200);
    const generation = await workspaceAccessGeneration(ws);
    expect(await agentBrandWorkspaceId(user, brand)).toBe(ws);
    expect((await suspend('now')).status).toBe(200);
    expect((await app.request('/api/v1/tickets', { headers: headers() })).status).toBe(403);
    const [workspace] = await sql`select slug from workspaces where id=${ws}`;
    expect((await app.request(`/api/v1/public/${workspace.slug}/config`)).status).toBe(403);
    await sql`update workspaces set portal_custom_domain=${`${ws}.example.test`},portal_custom_domain_verified=true where id=${ws}`;
    expect((await app.request(`/api/v1/public/resolve-host?host=${ws}.example.test`)).status).toBe(404);
    await sql`update users set is_platform_admin=false where id=${user}`;
    expect((await app.request('/api/v1/tickets', { headers: headers() })).status).toBe(403);
    await sql`update users set is_platform_admin=true where id=${user}`;
    expect((await app.request(`/api/v1/tickets/${ticket}/attachments/${attachment}/content`, { headers: headers() })).status).toBe(403);
    expect((await app.request('/api/v1/whoami', { headers: headers() })).status).toBe(200);
    expect(await agentBrandWorkspaceId(user, brand)).toBeNull();
    expect(await maestroBrandIdForWorkspace(ws)).toBeNull();
    await expect(assertHasBudget(ws)).rejects.toThrow();
    let sent = 0;
    await expect(sendWhileWorkspaceAvailable(ws, async () => ++sent)).rejects.toThrow();
    expect((await suspend(null)).status).toBe(200);
    await expect(sendWhileWorkspaceAvailable(ws, async () => ++sent, generation)).rejects.toThrow();
    expect(sent).toBe(0);
    expect((await app.request(`/api/v1/public/resolve-host?host=${ws}.example.test`)).status).toBe(200);
    expect((await app.request('/api/v1/tickets', { headers: headers() })).status).toBe(200);
  });

  it('checks suspension on previously issued private file links and rejects tampering', async () => {
    const { privateFileUrl, validPrivateFileLink } = await import('./lib/private-file-links.js');
    const file = { kind: 'attachment' as const, id: attachment, workspaceId: ws, storageKey: key };
    const url = new URL(privateFileUrl(file));
    expect(validPrivateFileLink(file, url.searchParams.get('expires')!, url.searchParams.get('signature')!)).toBe(true);
    expect(validPrivateFileLink({ ...file, id: crypto.randomUUID() }, url.searchParams.get('expires')!, url.searchParams.get('signature')!)).toBe(false);
    expect(validPrivateFileLink(file, '1000000000', url.searchParams.get('signature')!)).toBe(false);
    expect((await suspend('now')).status).toBe(200);
    expect((await app.request(url.pathname + url.search)).status).toBe(403);
    expect((await suspend(null)).status).toBe(200);
    const { env } = await import('./lib/env.js');
    const original = { R2_ACCOUNT_ID: env.R2_ACCOUNT_ID, R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY, R2_ATTACHMENTS_BUCKET: env.R2_ATTACHMENTS_BUCKET };
    const realFetch = globalThis.fetch;
    try {
      Object.assign(env, { R2_ACCOUNT_ID: 'test-only', R2_ACCESS_KEY_ID: 'test-only', R2_SECRET_ACCESS_KEY: 'test-only', R2_ATTACHMENTS_BUCKET: 'test-only' });
      globalThis.fetch = Object.assign(async () => new Response(new Uint8Array([137,80,78,71,13,10,26,10])), { preconnect: realFetch.preconnect });
      const response = await app.request(url.pathname + url.search);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await response.arrayBuffer()).byteLength).toBe(8);
      const tampered = new URL(url); tampered.searchParams.set('signature', 'x'.repeat(43));
      expect((await app.request(tampered.pathname + tampered.search)).status).toBe(403);
    } finally { Object.assign(env, original); globalThis.fetch = realFetch; }
  });

  it('parks queued webhooks through reactivation and waits for an already-started send', async () => {
    const { dispatchTicketEvent, processPendingDeliveries } = await import('./lib/outgoing-webhooks.js');
    const { sendWhileWorkspaceAvailable } = await import('./lib/workspace-access.js');
    await sql`insert into workspace_webhooks(workspace_id,name,url,secret,events)
      values (${ws},'Synthetic','https://example.test/hook','synthetic-secret',array['ticket.created'])`;
    expect(await dispatchTicketEvent({ workspaceId: ws, ticketId: ticket, event: 'ticket.created' })).toBe(1);
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    const sending = sendWhileWorkspaceAvailable(ws, async () => { started(); await release; return 'sent'; });
    await entered;
    let suspended = false;
    const suspending = suspend('now').then(response => { suspended = true; return response; });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(suspended).toBe(false);
    } finally { finish(); }
    expect(await sending).toBe('sent');
    expect((await suspending).status).toBe(200);
    expect((await sql`select state from webhook_deliveries where workspace_id=${ws}`)[0].state).toBe('exhausted');
    await suspend(null);
    expect((await processPendingDeliveries()).processed).toBe(0);
    expect((await sql`select state from webhook_deliveries where workspace_id=${ws}`)[0].state).toBe('exhausted');
  });

  it('quarantines suspended inbound mail once without starting AI or appending to the brand', async () => {
    const { processInboundEmail } = await import('./lib/inbound-email.js');
    const { PostmarkInbound } = await import('./lib/postmark.js');
    const payload = PostmarkInbound.parse({ MessageID: crypto.randomUUID(), From: `suspended-${crypto.randomUUID()}@example.test`,
      To: 'support@example.test', Subject: 'Preserve this mail', TextBody: 'Synthetic quarantine marker',
      Headers: [{ Name: 'Message-ID', Value: `<${crypto.randomUUID()}@example.test>` }] });
    await suspend('now');
    const first = await processInboundEmail({ workspaceId: ws, payload });
    try {
      expect(first.quarantined_workspace_id).toBe(ws);
      expect(first.auto_triage_queued).toBe(false);
      const [saved] = await sql`select workspace_id from tickets where id=${first.ticket_id}`;
      expect(saved.workspace_id).not.toBe(ws);
      expect((await processInboundEmail({ workspaceId: ws, payload })).ticket_id).toBe(first.ticket_id);
      expect(await sql`select id from audit_events where target_id=${first.ticket_id} and action='inbound.quarantined'`).toHaveLength(1);
    } finally {
      await sql`delete from tickets where id=${first.ticket_id}`;
      await sql`delete from customers where id=${first.customer_id}`;
      await suspend(null);
    }
  });

  it('discards AI results returned after a suspend/reactivate cycle', async () => {
    const { anthropic } = await import('./lib/anthropic.js');
    const { triageTicket } = await import('./lib/triage.js');
    const original = anthropic.messages.create;
    let calls = 0;
    try {
      anthropic.messages.create = (async () => {
        calls++;
        await suspend('now'); await suspend(null);
        return { id: 'synthetic-ai', usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', name: 'record_triage', input: { category_key: 'general', priority_key: 'normal',
            sentiment: 'neutral', summary: 'Stale result', draft_reply: 'Do not send', tags: [], confidence: 100 } }] };
      }) as any;
      await expect(triageTicket({ workspaceId: ws, ticketId: ticket, userId: user })).rejects.toThrow('This workspace is unavailable.');
      expect(calls).toBe(1);
      const [saved] = await sql`select ai_summary,ai_draft_reply from tickets where id=${ticket}`;
      expect(saved.ai_summary).toBeNull(); expect(saved.ai_draft_reply).toBeNull();
      expect(await sql`select id from ai_usage_log where workspace_id=${ws} and action='triage_discarded_suspension'`).toHaveLength(1);
    } finally { anthropic.messages.create = original; await suspend(null); }
  });
});
