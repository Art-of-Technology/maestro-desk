// Per-inbound-address ticket defaults — DB-backed (RUN_DB_TESTS). An email's
// To: address is matched to a workspace channel BEFORE the ticket insert and
// the channel's default_priority_key / default_category_key are applied
// (complaint@ lands urgent, support@ lands normal). Thread-attached replies
// never re-apply defaults, and inactive / soft-deleted channels never match.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

// env.ts validates process.env at import; provide hermetic fallbacks so the
// suite loads without a real api/.env. `||=` keeps real values when set.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('channel inbound defaults (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let processInboundEmail: typeof import('./lib/inbound-email.js').processInboundEmail;
  let resolveInboundChannel: typeof import('./lib/inbound-email.js').resolveInboundChannel;

  const RUN = Date.now();
  const ctx = {} as Record<string, string>;
  const addr = (local: string) => `${local}@ch-${RUN}.test`;

  // Stub fetch so fire-and-forget triage/sentiment/pubby calls don't hit the
  // network or mutate state mid-assertion — they fail fast and are swallowed.
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  function inbound(opts: { from: string; to: string; subject: string; text: string; messageId: string; inReplyTo?: string }) {
    const headers: Array<{ Name: string; Value: string }> = [{ Name: 'Message-Id', Value: opts.messageId }];
    if (opts.inReplyTo) headers.push({ Name: 'In-Reply-To', Value: opts.inReplyTo });
    return {
      MessageID: opts.messageId.replace(/[<>]/g, ''),
      From: opts.from,
      FromFull: { Email: opts.from, Name: 'Cust' },
      Subject: opts.subject,
      TextBody: opts.text,
      HtmlBody: '',
      ToFull: [{ Email: opts.to }],
      Headers: headers,
    } as any;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    ({ processInboundEmail, resolveInboundChannel } = await import('./lib/inbound-email.js'));

    // Workspace WITH channels. provision_brand seeds lookups (incl. the
    // 'Complaints' category + urgent/high/normal/low priorities) but NO
    // channels — each is created here. `support` is created FIRST so it is
    // the deterministic fallback (resolver orders created_at asc, id asc).
    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${'chd-' + RUN}, ${'chd-' + RUN}) as provision_brand`;
    ctx.ws = ws;

    const mkChannel = async (name: string, address: string, extra: { priority?: string; category?: string; status?: string; deleted?: boolean } = {}) => {
      const [row] = await sql<{ id: string }[]>`
        insert into channels
          (workspace_id, display_id, name, type, address, status, default_priority_key, default_category_key, deleted_at)
        values
          (${ws}, ${`CH-${name}-${RUN}`}, ${name}, 'email', ${address}, ${extra.status ?? 'active'},
           ${extra.priority ?? null}, ${extra.category ?? null}, ${extra.deleted ? new Date() : null})
        returning id`;
      return row.id;
    };
    ctx.chSupport    = await mkChannel('support', addr('support'));
    ctx.chComplaints = await mkChannel('complaints', addr('complaint'), { priority: 'urgent', category: 'Complaints' });
    ctx.chInactive   = await mkChannel('inactive', addr('inactive'), { priority: 'urgent', status: 'inactive' });
    ctx.chDeleted    = await mkChannel('deleted', addr('deleted'), { priority: 'urgent', deleted: true });

    // Workspace with NO channels at all.
    const [{ provision_brand: ws2 }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${'chd2-' + RUN}, ${'chd2-' + RUN}) as provision_brand`;
    ctx.wsBare = ws2;
  }, 30000);

  afterAll(async () => {
    await sql`delete from inbox_messages where workspace_id in (${ctx.ws}, ${ctx.wsBare})`;
    await sql`delete from ticket_messages where workspace_id in (${ctx.ws}, ${ctx.wsBare})`;
    await sql`delete from tickets where workspace_id in (${ctx.ws}, ${ctx.wsBare})`;
  });

  it('applies the matched channel defaults: complaint@ lands urgent + categorized', async () => {
    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: inbound({ from: `angry-${RUN}@cust.test`, to: addr('complaint'), subject: 'This is unacceptable', text: 'complaint body', messageId: `<c1-${RUN}@cust.test>` }),
    });
    expect(res.threaded).toBe(false);
    const [t] = await sql<{ priority_key: string; category_key: string | null }[]>`
      select priority_key, category_key from tickets where id = ${res.ticket_id}`;
    expect(t.priority_key).toBe('urgent');
    expect(t.category_key).toBe('Complaints');

    // Inbox audit row attributed to the SAME channel the defaults came from.
    const [inboxRow] = await sql<{ channel_id: string }[]>`
      select channel_id from inbox_messages where converted_ticket_id = ${res.ticket_id}`;
    expect(inboxRow.channel_id).toBe(ctx.chComplaints);
  });

  it('matches the To: address case-insensitively', async () => {
    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: inbound({ from: `shouty-${RUN}@cust.test`, to: addr('complaint').toUpperCase(), subject: 'CAPS', text: 'caps body', messageId: `<c2-${RUN}@cust.test>` }),
    });
    const [t] = await sql<{ priority_key: string }[]>`select priority_key from tickets where id = ${res.ticket_id}`;
    expect(t.priority_key).toBe('urgent');
  });

  it('falls back to the oldest active email channel on an unmatched To: (normal, no category)', async () => {
    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: inbound({ from: `misc-${RUN}@cust.test`, to: addr('info'), subject: 'Random question', text: 'info body', messageId: `<c3-${RUN}@cust.test>` }),
    });
    const [t] = await sql<{ priority_key: string; category_key: string | null }[]>`
      select priority_key, category_key from tickets where id = ${res.ticket_id}`;
    expect(t.priority_key).toBe('normal');
    expect(t.category_key).toBeNull();
    const [inboxRow] = await sql<{ channel_id: string }[]>`
      select channel_id from inbox_messages where converted_ticket_id = ${res.ticket_id}`;
    expect(inboxRow.channel_id).toBe(ctx.chSupport);
  });

  it('never matches inactive or soft-deleted channels', async () => {
    for (const to of [addr('inactive'), addr('deleted')]) {
      const ch = await resolveInboundChannel(ctx.ws, to);
      expect(ch?.id).toBe(ctx.chSupport);   // fell back — urgent channels excluded
    }
  });

  it('creates the ticket (normal, no inbox row) when the workspace has no channels', async () => {
    const res = await processInboundEmail({
      workspaceId: ctx.wsBare,
      payload: inbound({ from: `bare-${RUN}@cust.test`, to: addr('complaint'), subject: 'No channels here', text: 'bare body', messageId: `<c4-${RUN}@cust.test>` }),
    });
    const [t] = await sql<{ priority_key: string }[]>`select priority_key from tickets where id = ${res.ticket_id}`;
    expect(t.priority_key).toBe('normal');
    const inboxRows = await sql<{ id: string }[]>`
      select id from inbox_messages where converted_ticket_id = ${res.ticket_id}`;
    expect(inboxRows).toHaveLength(0);
  });

  it('thread-attach never re-applies defaults: a reply to complaint@ does not escalate', async () => {
    // Agent replies on the normal-priority info ticket; customer answers TO
    // the complaints address (e.g. they hit the wrong alias). The reply must
    // thread — at the ticket's existing priority — with the inbox row
    // attributed to the complaints channel.
    const AGENT_MSG_ID = `<agent-${RUN}@ch.test>`;
    const [infoTicket] = await sql<{ id: string }[]>`
      select id from tickets where workspace_id = ${ctx.ws} and subject = 'Random question'`;
    await sql`
      insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
      values (${ctx.ws}, ${infoTicket.id}, 'agent', 'Agent', 'our answer', ${AGENT_MSG_ID})`;

    const res = await processInboundEmail({
      workspaceId: ctx.ws,
      payload: inbound({ from: `misc-${RUN}@cust.test`, to: addr('complaint'), subject: 'Re: Random question', text: 'follow-up body', messageId: `<c5-${RUN}@cust.test>`, inReplyTo: AGENT_MSG_ID }),
    });
    expect(res.threaded).toBe(true);
    expect(res.ticket_id).toBe(infoTicket.id);

    const [t] = await sql<{ priority_key: string }[]>`select priority_key from tickets where id = ${infoTicket.id}`;
    expect(t.priority_key).toBe('normal');   // NOT escalated to urgent

    // The ticket now has TWO inbox rows (original + this reply) — pick the
    // reply's by its provider message id.
    const [inboxRow] = await sql<{ channel_id: string }[]>`
      select channel_id from inbox_messages
      where converted_ticket_id = ${infoTicket.id} and external_id = ${`<c5-${RUN}@cust.test>`}`;
    expect(inboxRow.channel_id).toBe(ctx.chComplaints);
  });

  it('channel write routes are mounted and require auth', async () => {
    expect((await app.request('/api/v1/channels', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/v1/channels/00000000-0000-0000-0000-000000000000', { method: 'PATCH' })).status).toBe(401);
    expect((await app.request('/api/v1/channels/00000000-0000-0000-0000-000000000000', { method: 'DELETE' })).status).toBe(401);
  });
});
