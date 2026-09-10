// Agent-reply email delivery — DB-backed (RUN_DB_TESTS). Posts agent replies
// and internal notes through POST /tickets/:id/messages with Postmark mocked,
// asserting: a public reply emails the customer and stamps the threading
// Message-Id; an internal note never emails; no-email and hard-bounced
// customers are saved-only with the right reason.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

// Hermetic env so imports resolve; force Postmark "configured" + a fallback
// sender so the send path runs and getOutboundFrom falls back cleanly.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';
process.env.POSTMARK_SERVER_TOKEN = 'test-server-token';
process.env.POSTMARK_OUTBOUND_FROM = 'support@maestro.test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('agent-reply email delivery (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;

  const RUN = Date.now();
  const admin = { email: `ar-admin-${RUN}@t.test` } as Record<string, string>;
  const ctx = {} as Record<string, string>;

  const realFetch = globalThis.fetch;
  let postmarkCalls = 0;
  let lastBody: any = null;
  let failMail = false;
  let mailGate: Promise<void> | null = null;

  beforeEach(() => {
    postmarkCalls = 0; lastBody = null; failMail = false; mailGate = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.postmarkapp.com/email')) {
        postmarkCalls++;
        lastBody = JSON.parse(String(init?.body ?? '{}'));
        if (mailGate) await mailGate;
        if (failMail) return new Response('Mail service unavailable', { status: 503 });
        return new Response(JSON.stringify({ MessageID: 'pm-id', SubmittedAt: '2026-01-01T00:00:00Z', To: 'x', ErrorCode: 0, Message: 'OK' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input as any, init);
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function signUp(email: string): Promise<{ id: string; token: string }> {
    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email, password: 'password-12345', name: 'Reply Agent' }, returnHeaders: true });
    return { id: r.response.user.id, token: r.response.token };
  }
  function as(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${admin.token}`);
    headers.set('X-Workspace-Id', ctx.wsId);
    headers.set('Content-Type', 'application/json');
    return app.request(path, { ...init, headers });
  }
  async function seedTicket(display: string, opts: { email: string | null; bounce?: string | null }): Promise<string> {
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (workspace_id, display_id, first_name, email, email_bounce_state)
      values (${ctx.wsId}, ${'C-' + display}, 'C', ${opts.email}, ${opts.bounce ?? 'none'}) returning id
    `;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${ctx.wsId}, ${display}, 'Need help', ${cust.id}, 'open', 'normal') returning id
    `;
    return t.id;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const ua = await signUp(admin.email);
    admin.userId = ua.id; admin.token = ua.token;
    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'ar-' + RUN}, ${'ar-' + RUN}) as provision_brand`;
    ctx.wsId = wsId;
    const [adminRole] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${wsId} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${wsId}, ${admin.userId}, ${adminRole.id}, true)`;
  }, 30000);

  afterAll(async () => {
    if (ctx.wsId) await sql`delete from workspaces where id = ${ctx.wsId}`;
    if (admin.userId) await sql`delete from users where id = ${admin.userId}`;
  });

  it('emails the customer on a public reply and stamps the threading Message-Id', async () => {
    const email = `cust1-${RUN}@acme.test`;
    const tid = await seedTicket(`AR-${RUN}-1`, { email });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'Here is your answer.' }) });
    expect(res.status).toBe(201);
    const { message, delivery } = await res.json() as any;
    expect(delivery.emailed).toBe(true);
    expect(postmarkCalls).toBe(1);
    expect(lastBody.To).toBe(email);
    expect(String(lastBody.Subject)).toMatch(/^Re:/);
    // The reply row carries the RFC Message-Id so a customer reply threads back.
    const [row] = await sql<{ external_message_id: string | null }[]>`
      select external_message_id from ticket_messages where id = ${message.id}
    `;
    expect(row.external_message_id).toMatch(/^<.+@.+>$/);
  });

  const patchTicket = (tid: string, body: unknown) => as(`/api/v1/tickets/${tid}`, { method: 'PATCH', body: JSON.stringify(body) });
  const requestSurvey = (tid: string) => as(`/api/v1/tickets/${tid}/csat`, { method: 'POST', body: '{}' });

  const closeTicket = (tid: string, body: unknown) => as(`/api/v1/tickets/${tid}/close`, { method: 'POST', body: JSON.stringify(body) });

  it('uses the public ticket inbox for agent replies, AI replies and surveys while preserving threading', async () => {
    const tid = await seedTicket(`AR-${RUN}-public-inbox`, { email: `public-${RUN}@acme.test` });
    const [channel] = await sql`insert into channels (workspace_id, display_id, name, type, address)
      values (${ctx.wsId}, ${'CH-public-' + RUN}, 'Complaints', 'email', 'complaints@acme.test') returning id`;
    await sql`update tickets set channel_id = ${channel.id} where id = ${tid}`;
    const inboundId = `<public-${RUN}@customer.test>`;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
      values (${ctx.wsId}, ${tid}, 'customer', 'Customer', 'Question', ${inboundId})`;
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'Answer' }) });
    expect(res.status).toBe(201);
    expect((await res.json() as any).delivery.emailed).toBe(true);
    expect(lastBody.ReplyTo).toBe('complaints@acme.test');
    expect(lastBody.Headers).toContainEqual({ Name: 'In-Reply-To', Value: inboundId });

    const { postAutoReply } = await import('./lib/auto-reply.js');
    const auto = await postAutoReply({ workspaceId: ctx.wsId, ticketId: tid, draftReply: 'Automatic answer', confidence: 1, model: 'test', workspaceName: 'Test' });
    expect(auto.posted).toBe(true);
    expect(lastBody.ReplyTo).toBe('complaints@acme.test');
    expect(lastBody.Headers).toContainEqual({ Name: 'In-Reply-To', Value: inboundId });

    const { sendCsatSurvey } = await import('./lib/csat-survey.js');
    await sql`update tickets set status_key = 'resolved', resolved_at = now() where id = ${tid}`;
    expect((await sendCsatSurvey({ workspaceId: ctx.wsId, ticketId: tid })).sent).toBe(true);
    expect(lastBody.ReplyTo).toBe('complaints@acme.test');
    expect(postmarkCalls).toBe(3);
  });

  it('falls back within the brand for missing, inactive, deleted, non-email or invalid inboxes', async () => {
    const { resolveTicketReplyTo } = await import('./lib/ticket-reply-to.js');
    const { env } = await import('./lib/env.js');
    const tid = await seedTicket(`AR-${RUN}-reply-fallback`, { email: `fallback-${RUN}@acme.test` });
    expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(env.POSTMARK_INBOUND_REPLY_ADDRESS || null);
    const domain = `reply-${RUN}.test`;
    await sql`insert into workspace_email_domains (workspace_id, domain, verified_at) values (${ctx.wsId}, ${domain}, now())`;
    try {
      // A verified sending domain without an inbound channel is insufficient.
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(env.POSTMARK_INBOUND_REPLY_ADDRESS || null);
      const [support] = await sql`insert into channels (workspace_id, display_id, name, type, address)
        values (${ctx.wsId}, ${'CH-support-' + RUN}, 'Support', 'email', ${`support@${domain}`}) returning id`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(`support@${domain}`);
      const [channel] = await sql`insert into channels (workspace_id, display_id, name, type, address)
        values (${ctx.wsId}, ${'CH-fallback-' + RUN}, 'Inbox', 'email', 'inbox@acme.test') returning id`;
      await sql`update tickets set channel_id = ${channel.id} where id = ${tid}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe('inbox@acme.test');
      await sql`update channels set status = 'inactive' where id = ${channel.id}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(`support@${domain}`);
      await sql`update channels set status = 'active', deleted_at = now() where id = ${channel.id}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(`support@${domain}`);
      await sql`update channels set deleted_at = null, type = 'chat' where id = ${channel.id}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(`support@${domain}`);
      await sql`update channels set type = 'email', address = ${'inbox@acme.test\r\nBcc: other@acme.test'} where id = ${channel.id}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(`support@${domain}`);
      await sql`update channels set address = '' where id = ${channel.id}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(`support@${domain}`);
      const sent = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'Fallback answer' }) });
      expect((await sent.json() as any).delivery.emailed).toBe(true);
      expect(lastBody.ReplyTo).toBe(`support@${domain}`);
      await sql`update channels set status = 'inactive' where id = ${support.id}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(env.POSTMARK_INBOUND_REPLY_ADDRESS || null);
      await sql`update channels set status = 'active', deleted_at = now() where id = ${support.id}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(env.POSTMARK_INBOUND_REPLY_ADDRESS || null);
      await sql`update tickets set deleted_at = now() where id = ${tid}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBeNull();
    } finally {
      await sql`delete from workspace_email_domains where workspace_id = ${ctx.wsId} and domain = ${domain}`;
    }
  });

  it('never uses another workspace ticket or channel as Reply-To', async () => {
    const { resolveTicketReplyTo } = await import('./lib/ticket-reply-to.js');
    const { env } = await import('./lib/env.js');
    const tid = await seedTicket(`AR-${RUN}-reply-isolation`, { email: `isolation-${RUN}@acme.test` });
    const [{ provision_brand: otherId }] = await sql`select provision_brand(${'reply-other-' + RUN}, 'Other')`;
    try {
      const [channel] = await sql`insert into channels (workspace_id, display_id, name, type, address)
        values (${otherId}, ${'CH-other-' + RUN}, 'Private inbox', 'email', 'private@other.test') returning id`;
      await sql`update tickets set channel_id = ${channel.id} where id = ${tid}`;
      expect(await resolveTicketReplyTo(ctx.wsId, tid)).toBe(env.POSTMARK_INBOUND_REPLY_ADDRESS || null);
      expect(await resolveTicketReplyTo(otherId, tid)).toBeNull();
      expect(await resolveTicketReplyTo(ctx.wsId, crypto.randomUUID())).toBeNull();
    } finally {
      await sql`update tickets set channel_id = null where id = ${tid}`;
      await sql`delete from workspaces where id = ${otherId}`;
    }
  });

  it('publishes closure through shared realtime middleware and enqueues one subscribed webhook', async () => {
    const tid = await seedTicket(`AR-${RUN}-close-events`, { email: null });
    const pubby = await import('./lib/pubby.js');
    const publish = spyOn(pubby, 'publishTicketChanged').mockResolvedValue(undefined);
    const [hook] = await sql`insert into workspace_webhooks (workspace_id, name, url, secret, events, active)
      values (${ctx.wsId}, 'Closure test', 'https://example.com/hook', 'test-secret', array['ticket.closed'], true) returning id`;
    try {
      // Exercise the subscription API as well as the dispatcher, without an outbound HTTP request.
      const configured = await as(`/api/v1/integrations/webhooks/${hook.id}`, {
        method: 'PATCH', body: JSON.stringify({ events: ['ticket.closed'] }),
      });
      expect(configured.status).toBe(200);
      expect((await closeTicket(tid, { reason: 'abuse', note: 'Private closure detail' })).status).toBe(200);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(ctx.wsId, tid);
      expect((await closeTicket(tid, { reason: 'abuse' })).status).toBe(200);
      const deliveries = await sql`select event, payload from webhook_deliveries where webhook_id = ${hook.id}`;
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].event).toBe('ticket.closed');
      expect(deliveries[0].payload.ticket.status).toBe('closed');
      expect(JSON.stringify(deliveries[0].payload)).not.toContain('Private closure detail');
      expect((await closeTicket(crypto.randomUUID(), { reason: 'other' })).status).toBe(404);
      expect(publish).toHaveBeenCalledTimes(2); // successful requests only, once per request
    } finally {
      publish.mockRestore();
      await sql`delete from workspace_webhooks where id = ${hook.id}`;
    }
  });

  it('keeps closure notes out of the authenticated customer portal and preserves closed status on replies', async () => {
    const display = `AR-${RUN}-close-portal`;
    const tid = await seedTicket(display, { email: `portal-${RUN}@acme.test` });
    const [ticket] = await sql`select customer_id from tickets where id = ${tid}`;
    const portal = await import('./lib/portal-auth.js');
    const { token } = await portal.createMagicLink({ workspaceId: ctx.wsId, customerId: ticket.customer_id });
    const session = await portal.verifyMagicLink({ workspaceId: ctx.wsId, token });
    if (!session) throw new Error('Portal session fixture failed');
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
      values (${ctx.wsId}, ${tid}, 'customer', 'Customer', 'Public question')`;
    await closeTicket(tid, { reason: 'duplicate', note: 'Internal assessment must remain private' });
    const path = `/api/v1/public/ar-${RUN}/customer/tickets/${display}`;
    const headers = { Authorization: `Bearer ${session.sessionToken}`, 'Content-Type': 'application/json' };
    const response = await app.request(path, { headers });
    expect(response.status).toBe(200);
    const data: any = await response.json();
    expect(data.ticket.status_key).toBe('closed');
    expect(data.ticket.messages).toHaveLength(1);
    expect(data.ticket.messages[0].body).toBe('Public question');
    expect(JSON.stringify(data)).not.toContain('Internal assessment');
    expect(data.ticket).not.toHaveProperty('closure_note');
    const reply = await app.request(`${path}/messages`, { method: 'POST', headers, body: JSON.stringify({ body: 'Customer follow-up' }) });
    expect(reply.status).toBe(201);
    const [after] = await sql`select status_key from tickets where id = ${tid}`;
    expect(after.status_key).toBe('closed');
    expect(postmarkCalls).toBe(0);
  });

  it('portal customer replies reopen pending/resolved tickets and preserve other statuses and assignment', async () => {
    const display = `AR-${RUN}-portal-status`;
    const tid = await seedTicket(display, { email: `portal-status-${RUN}@acme.test` });
    const [ticket] = await sql`select customer_id from tickets where id = ${tid}`;
    const portal = await import('./lib/portal-auth.js');
    const { token } = await portal.createMagicLink({ workspaceId: ctx.wsId, customerId: ticket.customer_id });
    const session = await portal.verifyMagicLink({ workspaceId: ctx.wsId, token });
    if (!session) throw new Error('Portal session fixture failed');
    const headers = { Authorization: `Bearer ${session.sessionToken}`, 'Content-Type': 'application/json' };
    for (const status of ['pending', 'resolved', 'open', 'escalated', 'gdpr', 'closed']) {
      await sql`update tickets set status_key = ${status}, priority_key = 'high', assigned_user_id = ${admin.userId},
        closure_reason = case when ${status} = 'closed' then 'duplicate' else null end,
        closed_at = case when ${status} = 'closed' then now() else null end,
        resolved_at = case when ${status} = 'resolved' then now() else null end where id = ${tid}`;
      const res = await app.request(`/api/v1/public/ar-${RUN}/customer/tickets/${display}/messages`,
        { method: 'POST', headers, body: JSON.stringify({ body: `Follow-up for ${status}` }) });
      expect(res.status).toBe(201);
      const [after] = await sql`select status_key, resolved_at, priority_key, assigned_user_id from tickets where id = ${tid}`;
      expect(after.status_key).toBe(['pending', 'resolved'].includes(status) ? 'open' : status);
      expect(after.resolved_at).toBeNull();
      expect(after.priority_key).toBe('high');
      expect(after.assigned_user_id).toBe(admin.userId);
    }
    expect(postmarkCalls).toBe(0);
  });

  it('closes without email, records the agent and reason, and blocks every survey path', async () => {
    const tid = await seedTicket(`AR-${RUN}-close`, { email: `close-${RUN}@acme.test` });
    await sql`update tickets set snoozed_until = now() + interval '1 day', sla_state = 'breach' where id = ${tid}`;
    const res = await closeTicket(tid, { reason: 'spam', note: 'Unsolicited advert' });
    expect(res.status).toBe(200);
    const [ticket] = await sql`select * from tickets where id = ${tid}`;
    expect(ticket.status_key).toBe('closed');
    expect(ticket.closure_reason).toBe('spam');
    expect(ticket.closed_by_user_id).toBe(admin.userId);
    expect(ticket.closed_at).toBeTruthy();
    expect(ticket.resolved_at).toBeNull();
    expect(ticket.snoozed_until).toBeNull();
    expect(ticket.sla_state).toBe('ok');
    const [audit] = await sql`select * from ticket_messages where ticket_id = ${tid} and role = 'system'`;
    expect(audit.author_user_id).toBe(admin.userId);
    expect(audit.body).toContain('Unsolicited advert');
    expect((await requestSurvey(tid)).status).toBe(409);
    const { sendCsatSurvey } = await import('./lib/csat-survey.js');
    expect(await sendCsatSurvey({ workspaceId: ctx.wsId, ticketId: tid })).toEqual({ sent: false, reason: 'not_resolved' });
    expect(postmarkCalls).toBe(0);
    expect((await patchTicket(tid, { status_key: 'resolved' })).status).toBe(409);
    const { postAutoReply } = await import('./lib/auto-reply.js');
    expect(await postAutoReply({ workspaceId: ctx.wsId, ticketId: tid, draftReply: 'Answer', confidence: 1, model: 'test', workspaceName: 'Test' }))
      .toEqual({ posted: false, reason: 'ticket_closed' });
    const { exportCustomer } = await import('./lib/gdpr-export.js');
    const exported = await exportCustomer({ workspaceId: ctx.wsId, customerId: ticket.customer_id });
    expect(exported?.tickets.find(t => t.display_id === `AR-${RUN}-close`)?.closure_note).toBe('Unsolicited advert');
    expect((await closeTicket(tid, { reason: 'abuse' })).status).toBe(200);
    const [{ count }] = await sql`select count(*)::int as count from ticket_messages where ticket_id = ${tid}`;
    expect(count).toBe(1);
    const report: any = await (await as('/api/v1/reports/sla-breaches?days=7')).json();
    expect(report.tickets.some((t: any) => t.id === tid)).toBe(false);
    expect((await patchTicket(tid, { status_key: 'open' })).status).toBe(200);
    const [reopened] = await sql`select * from tickets where id = ${tid}`;
    expect(reopened.closed_at).toBeNull();
    expect(reopened.closure_reason).toBeNull();
    // Reopening is explicit; normal resolution and its survey work again.
    expect((await patchTicket(tid, { status_key: 'resolved' })).status).toBe(200);
    expect(postmarkCalls).toBe(1);
  });

  it('requires a valid reason and rejects status-only closure without changing the ticket', async () => {
    const tid = await seedTicket(`AR-${RUN}-close-invalid`, { email: null });
    for (const body of [{}, { reason: 'invented' }, { reason: 'spam', note: 'x'.repeat(4001) }]) {
      expect((await closeTicket(tid, body)).status).toBe(400);
    }
    expect((await patchTicket(tid, { status_key: 'closed' })).status).toBe(400);
    const [t] = await sql`select status_key from tickets where id = ${tid}`;
    expect(t.status_key).toBe('open');
    expect(postmarkCalls).toBe(0);
  });

  it('does not close while a survey owns the ticket, or expose another workspace ticket', async () => {
    const tid = await seedTicket(`AR-${RUN}-close-sending`, { email: null });
    await sql`update tickets set csat_send_claim = ${crypto.randomUUID()}, csat_send_started_at = now() where id = ${tid}`;
    expect((await closeTicket(tid, { reason: 'duplicate' })).status).toBe(409);
    await sql`update tickets set csat_send_started_at = now() - interval '11 minutes' where id = ${tid}`;
    expect((await closeTicket(tid, { reason: 'duplicate' })).status).toBe(200);
    expect(postmarkCalls).toBe(0);
    await patchTicket(tid, { status_key: 'open' });
    const [{ provision_brand: otherId }] = await sql`select provision_brand(${'close-other-' + RUN}, 'Other')`;
    try {
      await sql`update tickets set workspace_id = ${otherId} where id = ${tid}`;
      expect((await closeTicket(tid, { reason: 'other' })).status).toBe(404);
    } finally {
      await sql`update tickets set workspace_id = ${ctx.wsId} where id = ${tid}`;
      await sql`delete from workspaces where id = ${otherId}`;
    }
  });

  it('resolving with an old browser stamp really sends once and returns the server timestamp', async () => {
    const tid = await seedTicket(`AR-${RUN}-csat-resolve`, { email: `survey-${RUN}@acme.test` });
    const res = await patchTicket(tid, { status_key: 'resolved', csat_requested_at: '2000-01-01' });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.survey).toEqual({ sent: true });
    expect(data.ticket.csat_requested_at).not.toContain('2000-01-01');
    expect(lastBody.To).toBe(`survey-${RUN}@acme.test`);
    expect(lastBody.Subject).toContain(`AR-${RUN}-csat-resolve`);
    const [row] = await sql`select csat_token, csat_requested_at from tickets where id = ${tid}`;
    expect(row.csat_token).toBeTruthy();
    expect(row.csat_requested_at).toBeTruthy();
    expect((await (await requestSurvey(tid)).json() as any).survey).toEqual({ sent: false, reason: 'already_requested' });
    await patchTicket(tid, { status_key: 'open' });
    await patchTicket(tid, { status_key: 'resolved' });
    expect(postmarkCalls).toBe(1);
    expect((await patchTicket(tid, { csat_requested_at: null })).status).toBe(400);
  });

  it('leaves failed sends retryable and the manual endpoint sends real mail', async () => {
    const tid = await seedTicket(`AR-${RUN}-csat-retry`, { email: `retry-${RUN}@acme.test` });
    failMail = true;
    const failed: any = await (await patchTicket(tid, { status_key: 'resolved' })).json();
    expect(failed.survey).toEqual({ sent: false, reason: 'send_failed' });
    expect(failed.ticket.csat_requested_at).toBeNull();
    const [before] = await sql`select csat_send_claim from tickets where id = ${tid}`;
    expect(before.csat_send_claim).toBeNull();
    failMail = false;
    const sent: any = await (await requestSurvey(tid)).json();
    expect(sent.survey).toEqual({ sent: true });
    expect(sent.ticket.csat_requested_at).toBeTruthy();
    expect(sent.survey.token).toBeUndefined();
  });

  it('serializes simultaneous manual and automatic requests across the database claim', async () => {
    const tid = await seedTicket(`AR-${RUN}-csat-race`, { email: `race-${RUN}@acme.test` });
    let release!: () => void;
    mailGate = new Promise<void>(r => { release = r; });
    const pending = patchTicket(tid, { status_key: 'resolved' });
    try {
      for (let n = 0; n < 100 && postmarkCalls === 0; n++) await new Promise(r => setTimeout(r, 10));
      expect(postmarkCalls).toBe(1);
      const duplicate: any = await (await requestSurvey(tid)).json();
      expect(duplicate.survey).toEqual({ sent: false, reason: 'in_progress' });
      expect(duplicate.ticket.csat_requested_at).toBeNull();
      expect((await closeTicket(tid, { reason: 'duplicate' })).status).toBe(409);
    } finally { release(); }
    expect((await (await pending).json() as any).survey).toEqual({ sent: true });
    expect(postmarkCalls).toBe(1);
    expect((await closeTicket(tid, { reason: 'duplicate' })).status).toBe(200);
  });

  it('retries a legacy false stamp and an expired claim without resending rated tickets', async () => {
    const tid = await seedTicket(`AR-${RUN}-csat-legacy`, { email: `legacy-${RUN}@acme.test` });
    await sql`update tickets set status_key = 'resolved', csat_requested_at = now(),
      csat_send_claim = ${crypto.randomUUID()}, csat_send_started_at = now() - interval '11 minutes' where id = ${tid}`;
    expect((await (await requestSurvey(tid)).json() as any).survey).toEqual({ sent: true });
    await sql`update tickets set csat_token = null, csat_submitted_at = now(), csat_score = 4 where id = ${tid}`;
    expect((await (await requestSurvey(tid)).json() as any).survey).toEqual({ sent: false, reason: 'already_rated' });
    expect(postmarkCalls).toBe(1);
  });

  it('preserves accepted delivery when releasing the claim fails', async () => {
    const tid = await seedTicket(`AR-${RUN}-csat-release`, { email: `release-${RUN}@acme.test` });
    const fn = `csat_release_test_${RUN}`;
    // Test-only trigger, targeted at this fixture; a real SQL failure exercises
    // the finally path without mocking away the successful send and stamp.
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$
      begin if new.id = '${tid}' and old.csat_send_claim is not null and new.csat_send_claim is null
        then raise exception 'test release failure' using errcode = '23514'; end if; return new; end $$;
      create trigger ${fn} before update on tickets for each row execute function ${fn}()`);
    try {
      const r: any = await (await patchTicket(tid, { status_key: 'resolved' })).json();
      expect(r.survey).toEqual({ sent: true });
      expect(r.ticket.csat_requested_at).toBeTruthy();
      const [row] = await sql`select csat_token, csat_send_claim from tickets where id = ${tid}`;
      expect(row.csat_token).toBeTruthy();
      expect(row.csat_send_claim).toBeTruthy();
      expect(postmarkCalls).toBe(1);
    } finally {
      await sql.unsafe(`drop trigger ${fn} on tickets; drop function ${fn}()`);
    }
  });

  it('does not report a confirmed survey if a newer claim replaced the sender', async () => {
    const tid = await seedTicket(`AR-${RUN}-csat-lost-claim`, { email: `lost-${RUN}@acme.test` });
    let release!: () => void;
    mailGate = new Promise<void>(r => { release = r; });
    const pending = patchTicket(tid, { status_key: 'resolved' });
    const replacement = crypto.randomUUID();
    try {
      for (let n = 0; n < 100 && postmarkCalls === 0; n++) await new Promise(r => setTimeout(r, 10));
      expect(postmarkCalls).toBe(1);
      await sql`update tickets set csat_send_claim = ${replacement} where id = ${tid}`;
    } finally { release(); }
    const r: any = await (await pending).json();
    expect(r.survey).toEqual({ sent: false, reason: 'send_failed' });
    expect(r.ticket.csat_requested_at).toBeNull();
    const [row] = await sql`select csat_send_claim from tickets where id = ${tid}`;
    expect(row.csat_send_claim).toBe(replacement);
  });

  it('does not claim delivery for opt-outs, suppressed or missing addresses', async () => {
    for (const kind of ['no_email', 'no_consent', 'email_suppressed']) {
      const tid = await seedTicket(`AR-${RUN}-${kind}`, { email: kind === 'no_email' ? null : `${kind}-${RUN}@acme.test`, bounce: kind === 'email_suppressed' ? 'hard' : 'none' });
      if (kind === 'no_consent') await sql`update customers set consent = false where id = (select customer_id from tickets where id = ${tid})`;
      const r: any = await (await patchTicket(tid, { status_key: 'resolved' })).json();
      expect(r.survey).toEqual({ sent: false, reason: kind });
      expect(r.ticket.csat_requested_at).toBeNull();
    }
    expect(postmarkCalls).toBe(0);
  });

  it('requires authentication, a visible resolved ticket and rejects deleted tickets', async () => {
    const tid = await seedTicket(`AR-${RUN}-csat-auth`, { email: `auth-${RUN}@acme.test` });
    expect((await app.request(`/api/v1/tickets/${tid}/csat`, { method: 'POST' })).status).toBe(401);
    expect((await requestSurvey(tid)).status).toBe(409);
    expect((await requestSurvey(crypto.randomUUID())).status).toBe(404);
    expect((await requestSurvey('bad-id')).status).toBe(404);
    const [{ provision_brand: otherId }] = await sql`select provision_brand(${'csat-other-' + RUN}, ${'csat-other-' + RUN})`;
    try {
      await sql`update tickets set workspace_id = ${otherId}, status_key = 'resolved' where id = ${tid}`;
      expect((await requestSurvey(tid)).status).toBe(404);
    } finally {
      await sql`update tickets set workspace_id = ${ctx.wsId} where id = ${tid}`;
      await sql`delete from workspaces where id = ${otherId}`;
    }
    await sql`update tickets set deleted_at = now() where id = ${tid}`;
    expect((await requestSurvey(tid)).status).toBe(404);
    expect(postmarkCalls).toBe(0);
  });

  async function contactTicket(label: string, primaryBounce = 'none') {
    const primary = `${label}-primary-${RUN}@acme.test`;
    const secondary = `${label}-secondary-${RUN}@acme.test`;
    const tid = await seedTicket(`AR-${RUN}-${label}`, { email: primary, bounce: primaryBounce });
    const [ticket] = await sql`select customer_id from tickets where id = ${tid}`;
    const res = await as(`/api/v1/customers/${ticket.customer_id}/contacts`, {
      method: 'POST', body: JSON.stringify({ kind: 'email', value: secondary }),
    });
    expect(res.status).toBe(201);
    await sql`update tickets set last_inbound_email = ${secondary.toUpperCase()} where id = ${tid}`;
    return { tid, cid: ticket.customer_id as string, primary, secondary };
  }

  async function reply(tid: string) {
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST', body: JSON.stringify({ role: 'agent', body: 'Address test' }),
    });
    expect(res.status).toBe(201);
    return await res.json() as { delivery: { emailed: boolean; reason: string } };
  }

  it('sends a rich reply to the live thread address even when the primary is hard-bounced', async () => {
    const { tid, secondary } = await contactTicket('thread', 'hard');
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST', body: JSON.stringify({ role: 'agent', body_html: '<p>Hello <b>again</b></p>' }),
    });
    expect(res.status).toBe(201);
    expect(lastBody.To).toBe(secondary);
    expect(lastBody.HtmlBody).toContain('<b>again</b>');
  });

  it('holds hard/spam thread addresses without redirecting to a healthy primary; soft bounces send', async () => {
    const { tid, cid, secondary } = await contactTicket('suppressed');
    for (const state of ['hard', 'spam', 'soft']) {
      await sql`update customer_contacts set bounce_state = ${state}
        where workspace_id = ${ctx.wsId} and customer_id = ${cid} and value = ${secondary}`;
      const { delivery } = await reply(tid);
      expect(delivery.reason).toBe(state === 'soft' ? 'sent' : 'email_suppressed');
      expect(delivery.emailed).toBe(state === 'soft');
    }
    expect(postmarkCalls).toBe(1);
    expect(lastBody.To).toBe(secondary);
  });

  it('falls back after removal even if another customer now owns the old thread address', async () => {
    const { tid, cid, primary, secondary } = await contactTicket('removed');
    const [contact] = await sql`select id from customer_contacts where customer_id = ${cid} and value = ${secondary}`;
    const removed = await as(`/api/v1/customers/${cid}/contacts/${contact.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    await seedTicket(`AR-${RUN}-new-owner`, { email: secondary });
    const { delivery } = await reply(tid);
    expect(delivery.emailed).toBe(true);
    expect(lastBody.To).toBe(primary);
  });

  it('AI replies and surveys use the same thread address and suppression policy', async () => {
    const { postAutoReply } = await import('./lib/auto-reply.js');
    const { sendCsatSurvey } = await import('./lib/csat-survey.js');
    const { tid, cid, secondary } = await contactTicket('automatic', 'hard');
    const auto = await postAutoReply({ workspaceId: ctx.wsId, ticketId: tid, draftReply: 'Answer', confidence: 1, model: 'test', workspaceName: 'Test' });
    expect(auto.posted).toBe(true);
    expect(lastBody.To).toBe(secondary);
    await sql`update tickets set status_key = 'resolved', resolved_at = now() where id = ${tid}`;
    const survey = await sendCsatSurvey({ workspaceId: ctx.wsId, ticketId: tid });
    expect(survey.sent).toBe(true);
    expect(lastBody.To).toBe(secondary);

    await sql`delete from events where workspace_id = ${ctx.wsId} and entity_id = ${tid} and kind = 'auto_reply'`;
    await sql`update tickets set csat_requested_at = null where id = ${tid}`;
    await sql`update customer_contacts set bounce_state = 'hard' where customer_id = ${cid} and value = ${secondary}`;
    const heldAuto = await postAutoReply({ workspaceId: ctx.wsId, ticketId: tid, draftReply: 'Answer', confidence: 1, model: 'test', workspaceName: 'Test' });
    expect(heldAuto).toEqual({ posted: false, reason: 'email_suppressed' });
    expect(await sendCsatSurvey({ workspaceId: ctx.wsId, ticketId: tid })).toEqual({ sent: false, reason: 'email_suppressed' });
    expect(postmarkCalls).toBe(2);
  });

  it('retains address routing across merge and unmerge, and exports then erases the stored address', async () => {
    const { tid, cid, secondary } = await contactTicket('merge-routing');
    const survivorTid = await seedTicket(`AR-${RUN}-survivor-routing`, { email: `survivor-${RUN}@acme.test` });
    const [survivor] = await sql`select customer_id from tickets where id = ${survivorTid}`;
    const merged = await as(`/api/v1/customers/${cid}/merge`, {
      method: 'POST', body: JSON.stringify({ into_id: survivor.customer_id }),
    });
    expect(merged.status).toBe(200);
    expect((await reply(tid)).delivery.emailed).toBe(true);
    expect(lastBody.To).toBe(secondary);
    const unmerged = await as(`/api/v1/customers/${cid}/unmerge`, { method: 'POST' });
    expect(unmerged.status).toBe(200);
    expect((await reply(tid)).delivery.emailed).toBe(true);
    expect(lastBody.To).toBe(secondary);
    const { exportCustomer } = await import('./lib/gdpr-export.js');
    const exported = await exportCustomer({ workspaceId: ctx.wsId, customerId: cid });
    expect(exported?.tickets.find((t) => t.display_id === `AR-${RUN}-merge-routing`)?.last_inbound_email?.toString().toLowerCase()).toBe(secondary);
    const { eraseCustomer } = await import('./lib/gdpr-erasure.js');
    const erased = await eraseCustomer({ workspaceId: ctx.wsId, customerId: cid, requestedByUserId: admin.userId });
    expect(erased?.fieldsErased).toContain('tickets.last_inbound_email');
    const [row] = await sql`select last_inbound_email from tickets where id = ${tid}`;
    expect(row.last_inbound_email).toBeNull();
    expect((await reply(tid)).delivery.emailed).toBe(false);
  });

  it('sends a plain-text-only reply with no HTML part when the workspace has nothing to brand', async () => {
    const tid = await seedTicket(`AR-${RUN}-html0`, { email: `cust-h0-${RUN}@acme.test` });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'plain words' }) });
    expect(res.status).toBe(201);
    expect(lastBody.TextBody).toContain('plain words');
    expect(lastBody.HtmlBody).toBeUndefined();      // unchanged pre-rich behaviour
    expect(lastBody.Attachments).toBeUndefined();
  });

  it('sends a rich-text reply as HTML, derives the text part, and sanitises the agent’s markup', async () => {
    const tid = await seedTicket(`AR-${RUN}-html1`, { email: `cust-h1-${RUN}@acme.test` });
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST',
      // No `body` at all: the text part must be derived from the HTML. The
      // <script> and the onclick are the agent-side XSS guard.
      body: JSON.stringify({ role: 'agent', body_html: '<p>Hello <b>Nina</b></p><p>See <a href="https://ok.test">this link</a></p><script>alert(1)</script><div onclick="x()">click</div>' }),
    });
    expect(res.status).toBe(201);
    const { message, delivery } = await res.json() as any;
    expect(delivery.emailed).toBe(true);
    // HTML part goes out with the formatting, without the script/handler.
    expect(lastBody.HtmlBody).toContain('<b>Nina</b>');
    expect(lastBody.HtmlBody).not.toContain('<script');
    expect(lastBody.HtmlBody).not.toMatch(/onclick/i);
    // Every link is forced to open in a new tab with no opener.
    expect(lastBody.HtmlBody).toContain('rel="noopener noreferrer"');
    // Text part derived for plain-text clients: readable, links preserved.
    expect(lastBody.TextBody).toContain('Hello Nina');
    expect(lastBody.TextBody).toContain('https://ok.test');
    expect(lastBody.TextBody).not.toContain('<p>');
    // Stored the same way.
    const [row] = await sql<{ body: string; body_html: string | null }[]>`
      select body, body_html from ticket_messages where id = ${message.id}`;
    expect(row.body_html).toContain('<b>Nina</b>');
    expect(row.body_html).not.toContain('<script');
    expect(row.body).toContain('Hello Nina');
  });

  it('emails attachments, tagging a pasted image as an inline cid part', async () => {
    const tid = await seedTicket(`AR-${RUN}-att`, { email: `cust-att-${RUN}@acme.test` });
    // A file uploaded earlier (unclaimed) plus an image pasted into the editor.
    const [att] = await sql<{ id: string }[]>`
      insert into ticket_attachments (workspace_id, ticket_id, filename, size_bytes, storage_key, mime_type, disposition)
      values (${ctx.wsId}, ${tid}, 'report.pdf', 14, ${`att/${ctx.wsId}/${tid}/seed/report.pdf`}, 'application/pdf', 'attachment')
      returning id`;
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString('base64');
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        role: 'agent',
        body: 'see attached',
        body_html: `<p>see attached</p><img src="data:image/png;base64,${pngB64}">`,
        attachment_ids: [att.id],
      }),
    });
    // The pasted image needs object storage, which is unconfigured in tests —
    // the request is refused cleanly rather than emailing a broken message.
    expect(res.status).toBe(503);
    const { error } = await res.json() as any;
    expect(error).toMatch(/storage is not configured/i);
    expect(postmarkCalls).toBe(0);
    // Nothing was claimed, so the file is still available for the next attempt.
    const [row] = await sql<{ message_id: string | null }[]>`select message_id from ticket_attachments where id = ${att.id}`;
    expect(row.message_id).toBeNull();
  });

  it('refuses attachment ids from another ticket without saving the reply', async () => {
    const tid = await seedTicket(`AR-${RUN}-x1`, { email: `cust-x1-${RUN}@acme.test` });
    const other = await seedTicket(`AR-${RUN}-x2`, { email: `cust-x2-${RUN}@acme.test` });
    const [att] = await sql<{ id: string }[]>`
      insert into ticket_attachments (workspace_id, ticket_id, filename, size_bytes, storage_key, mime_type, disposition)
      values (${ctx.wsId}, ${other}, 'theirs.pdf', 10, ${`att/${ctx.wsId}/${other}/seed/theirs.pdf`}, 'application/pdf', 'attachment')
      returning id`;
    const res = await as(`/api/v1/tickets/${tid}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'agent', body: 'here', attachment_ids: [att.id] }),
    });
    expect(res.status).toBe(400);
    expect(postmarkCalls).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ticket_messages where ticket_id = ${tid} and role = 'agent'`;
    expect(n).toBe(0);                                // no orphaned reply row
    const [row] = await sql<{ message_id: string | null }[]>`select message_id from ticket_attachments where id = ${att.id}`;
    expect(row.message_id).toBeNull();                // and the other ticket's file is untouched
  });

  it('rejects a body-less, html-less message', async () => {
    const tid = await seedTicket(`AR-${RUN}-empty`, { email: `cust-e-${RUN}@acme.test` });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent' }) });
    expect(res.status).toBe(400);
  });

  it('does not email an internal note', async () => {
    const tid = await seedTicket(`AR-${RUN}-2`, { email: `cust2-${RUN}@acme.test` });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'note', body: 'internal only' }) });
    expect(res.status).toBe(201);
    const { delivery } = await res.json() as any;
    expect(delivery).toBeUndefined();
    expect(postmarkCalls).toBe(0);
  });

  it('saves but does not email when the customer has no address', async () => {
    const tid = await seedTicket(`AR-${RUN}-3`, { email: null });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'hi' }) });
    const { delivery } = await res.json() as any;
    expect(delivery.emailed).toBe(false);
    expect(delivery.reason).toBe('no_customer_email');
    expect(postmarkCalls).toBe(0);
  });

  it('skips hard-bounced / spam-flagged addresses', async () => {
    const tid = await seedTicket(`AR-${RUN}-4`, { email: `bounced-${RUN}@acme.test`, bounce: 'hard' });
    const res = await as(`/api/v1/tickets/${tid}/messages`, { method: 'POST', body: JSON.stringify({ role: 'agent', body: 'hi' }) });
    const { delivery } = await res.json() as any;
    expect(delivery.emailed).toBe(false);
    expect(delivery.reason).toBe('email_suppressed');
    expect(postmarkCalls).toBe(0);
  });
});
