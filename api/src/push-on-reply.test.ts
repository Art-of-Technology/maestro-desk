// Offline-agent push on a customer reply (push stage 3). DB-backed
// (RUN_DB_TESTS). A threaded reply pushes the assigned agent only when they're
// offline and we haven't already pushed about this turn. VAPID is configured
// by the bun preload; webpush.sendNotification is stubbed (no network).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import webpush from 'web-push';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('offline-agent push on reply (DB-backed)', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let processInboundEmail: typeof import('./lib/inbound-email.js').processInboundEmail;

  const RUN = Date.now();
  const ctx = {} as Record<string, string>;
  const AGENT_MSG_ID = `<agent-${RUN}@weezboo.com>`;
  const realSend = webpush.sendNotification;
  const realFetch = globalThis.fetch;
  let pushCount = 0;
  let replyN = 0;

  function inboundReply() {
    const mid = `<r${++replyN}-${RUN}@cust.test>`;
    return {
      MessageID: mid.replace(/[<>]/g, ''),
      From: ctx.custEmail, FromFull: { Email: ctx.custEmail, Name: 'Cust' },
      Subject: 'Re: Need help', TextBody: 'another reply', HtmlBody: '',
      ToFull: [{ Email: 'sharedhash@inbound.postmarkapp.com' }],
      Headers: [{ Name: 'Message-Id', Value: mid }, { Name: 'In-Reply-To', Value: AGENT_MSG_ID }],
    } as any;
  }

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    processInboundEmail = (await import('./lib/inbound-email.js')).processInboundEmail;

    const { auth } = await import('./lib/auth.js');
    const r: any = await auth.api.signUpEmail({ body: { email: `por-agent-${RUN}@t.test`, password: 'password-12345', name: 'Agent' }, returnHeaders: true });
    ctx.agentId = r.response.user.id;

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`select provision_brand(${'por-' + RUN}, ${'por-' + RUN}) as provision_brand`;
    ctx.wsId = ws;
    const [role] = await sql<{ id: string }[]>`select id from roles where workspace_id = ${ws} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${ctx.agentId}, ${role.id}, true)`;

    ctx.custEmail = `por-cust-${RUN}@cust.test`;
    const [cust] = await sql<{ id: string }[]>`insert into customers (workspace_id, display_id, first_name, email) values (${ws}, ${'C-' + RUN}, 'C', ${ctx.custEmail}) returning id`;
    const [t] = await sql<{ id: string }[]>`
      insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key, assigned_user_id)
      values (${ws}, ${'POR-' + RUN}, 'Need help', ${cust.id}, 'open', 'normal', ${ctx.agentId}) returning id`;
    ctx.ticketId = t.id;
    // Agent reply carrying a known Message-Id, so the inbound reply threads onto this ticket.
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
              values (${ws}, ${t.id}, 'agent', 'Agent', 'hi', ${AGENT_MSG_ID})`;
    // The agent has one registered push device.
    await sql`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (${ctx.agentId}, ${`https://push.example.com/por-${RUN}`}, 'p', 'a')`;
  }, 30000);

  beforeEach(() => {
    pushCount = 0;
    webpush.sendNotification = (async () => { pushCount++; return { statusCode: 201 } as any; }) as any;
    // Swallow triage/sentiment/pubby network (those use global fetch).
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
  });
  afterEach(() => { webpush.sendNotification = realSend; globalThis.fetch = realFetch; });
  afterAll(async () => {
    await sql`delete from push_subscriptions where user_id = ${ctx.agentId}`;
    await sql`delete from ticket_messages where workspace_id = ${ctx.wsId}`;
    await sql`delete from tickets where workspace_id = ${ctx.wsId}`;
  });

  it('pushes the offline assigned agent and sets the throttle', async () => {
    await sql`update users set last_active_at = now() - interval '10 minutes' where id = ${ctx.agentId}`;
    await sql`update tickets set last_reply_notified_at = null where id = ${ctx.ticketId}`;
    await processInboundEmail({ workspaceId: ctx.wsId, payload: inboundReply() });
    expect(pushCount).toBe(1);
    const [t] = await sql<{ last_reply_notified_at: string | null }[]>`select last_reply_notified_at from tickets where id = ${ctx.ticketId}`;
    expect(t.last_reply_notified_at).not.toBeNull();
  });

  it('does not re-push while already notified (throttle)', async () => {
    await sql`update users set last_active_at = now() - interval '10 minutes' where id = ${ctx.agentId}`;
    await sql`update tickets set last_reply_notified_at = now() where id = ${ctx.ticketId}`;
    await processInboundEmail({ workspaceId: ctx.wsId, payload: inboundReply() });
    expect(pushCount).toBe(0);
  });

  it('does not push an online agent (they get the in-app toast)', async () => {
    await sql`update users set last_active_at = now() where id = ${ctx.agentId}`;
    await sql`update tickets set last_reply_notified_at = null where id = ${ctx.ticketId}`;
    await processInboundEmail({ workspaceId: ctx.wsId, payload: inboundReply() });
    expect(pushCount).toBe(0);
  });
});
