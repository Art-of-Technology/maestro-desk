import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=disable';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';
process.env.POSTMARK_SERVER_TOKEN = 'test-server-token';
process.env.POSTMARK_OUTBOUND_FROM = 'support@maestro.test';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('contact spam filtering', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let inbound: typeof import('./lib/inbound-email.js').processInboundEmail;
  let userId: string, token: string, workspaceId: string, otherWorkspace: string;
  let customerId: string, ticketId: string;
  const run = crypto.randomUUID();
  const email = `spam-${run}@test.example`, secondary = `secondary-${run}@test.example`;
  const originalId = `<original-${run}@test.example>`;
  const spies: { mockRestore(): void }[] = [];
  let triageCalls = 0, sentimentCalls = 0;

  const request = (path: string, method: string, body?: unknown, ws = workspaceId) => app.request('/api/v1' + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (from = email, parent?: string) => ({
    MessageID: crypto.randomUUID(), From: from, FromFull: { Email: from, Name: 'Sender' },
    Subject: 'Incoming mail', TextBody: 'Message kept for review', HtmlBody: '',
    ToFull: [{ Email: 'support@test.example' }],
    Headers: [{ Name: 'Message-Id', Value: `<${crypto.randomUUID()}@test.example>` },
      ...(parent ? [{ Name: 'In-Reply-To', Value: parent }] : [])],
  });
  async function assertSpam(id: string) {
    const [ticket] = await sql`select status_key, closure_reason, resolved_at, csat_requested_at, assigned_user_id from tickets where id = ${id}`;
    expect(ticket.status_key).toBe('closed');
    expect(ticket.closure_reason).toBe('spam');
    expect(ticket.resolved_at).toBeNull();
    expect(ticket.csat_requested_at).toBeNull();
  }

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const authResult = await auth.api.signUpEmail({ body: { email: `spam-agent-${run}@test.example`, password: 'password-12345', name: 'Spam Agent' } });
    userId = authResult.user.id; token = authResult.token!;
    for (const suffix of ['primary', 'other']) {
      const [{ provision_brand: id }] = await sql`select provision_brand(${'spam-' + suffix + '-' + run}, ${suffix})`;
      if (suffix === 'primary') workspaceId = id; else otherWorkspace = id;
      const [role] = await sql`select id from roles where workspace_id = ${id} and is_admin limit 1`;
      await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${id}, ${userId}, ${role.id}, true)`;
    }
    const [contact] = await sql`insert into customers (workspace_id, display_id, first_name, email)
      values (${workspaceId}, 'SPAM-C', 'Contact', ${email}) returning id`;
    customerId = contact.id;
    const { addContact } = await import('./lib/customer-contacts.js');
    await addContact(sql, { workspaceId, customerId, kind: 'email', value: secondary });
    const [ticket] = await sql`insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${workspaceId}, 'SPAM-T', 'Unsolicited mail', ${customerId}, 'open', 'normal') returning id`;
    ticketId = ticket.id;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
      values (${workspaceId}, ${ticketId}, 'customer', 'Sender', 'Original mail', ${originalId})`;
    spies.push(spyOn(await import('./lib/triage.js'), 'triageTicket').mockImplementation(async () => { triageCalls++; return {} as any; }));
    spies.push(spyOn(await import('./lib/sentiment.js'), 'scoreMessageSentiment').mockImplementation(async () => { sentimentCalls++; return null as any; }));
    spies.push(spyOn(await import('./lib/player-identity.js'), 'scheduleLink').mockImplementation(() => {}));
    spies.push(spyOn(await import('./lib/pubby.js'), 'publishTicketChanged').mockImplementation(async () => {}));
    inbound = (await import('./lib/inbound-email.js')).processInboundEmail;
  }, 30000);

  afterAll(async () => {
    spies.forEach(spy => spy.mockRestore());
    if (workspaceId) await sql`delete from workspaces where id = ${workspaceId}`;
    if (otherWorkspace) await sql`delete from workspaces where id = ${otherWorkspace}`;
    if (userId) await sql`delete from users where id = ${userId}`;
  });

  it('marks the contact and ticket atomically, with no resolution or survey; retries are idempotent', async () => {
    for (let retry = 0; retry < 2; retry++) expect((await request(`/tickets/${ticketId}/close`, 'POST', { reason: 'spam' })).status).toBe(200);
    await assertSpam(ticketId);
    expect((await sql`select is_spam from customers where id = ${customerId}`)[0].is_spam).toBe(true);
    const audit = await sql`select id from audit_events where target_id = ${customerId} and action = 'customer.spam_marked'`;
    expect(audit).toHaveLength(1);
    const { sendCsatSurvey } = await import('./lib/csat-survey.js');
    expect(await sendCsatSurvey({ workspaceId, ticketId })).toMatchObject({ sent: false });
    const { resolveTicketRecipient } = await import('./lib/ticket-recipient.js');
    expect(await resolveTicketRecipient(workspaceId, ticketId)).toMatchObject({ suppressed: true });
  });

  it('files new emails from every contact address as spam, without AI or assignment', async () => {
    for (const from of [email.toUpperCase(), secondary]) {
      const mail = payload(from);
      const result = await inbound({ workspaceId, payload: mail });
      await assertSpam(result.ticket_id);
      expect(result.customer_id).toBe(customerId);
      expect(result.auto_triage_queued).toBe(false);
      expect((await sql`select assigned_user_id from tickets where id = ${result.ticket_id}`)[0].assigned_user_id).toBeNull();
      expect((await inbound({ workspaceId, payload: mail })).deduped).toBe(true);
    }
    expect(triageCalls).toBe(0); expect(sentimentCalls).toBe(0);
  });

  it('keeps spam replies closed in the original workspace, even through a shared inbox', async () => {
    const result = await inbound({ workspaceId: otherWorkspace, payload: payload(secondary, originalId) });
    expect(result.threaded).toBe(true); expect(result.ticket_id).toBe(ticketId);
    await assertSpam(ticketId);
    expect(result.auto_triage_queued).toBe(false);
    expect(triageCalls).toBe(0); expect(sentimentCalls).toBe(0);
  });

  it('isolates a spam sender who replies to somebody else’s ticket', async () => {
    const [other] = await sql`insert into customers (workspace_id, display_id, first_name, email)
      values (${workspaceId}, 'GOOD-C', 'Other', ${'good-' + email}) returning id`;
    const [ticket] = await sql`insert into tickets (workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values (${workspaceId}, 'GOOD-T', 'Real help', ${other.id}, 'resolved', 'normal') returning id`;
    const parent = `<good-${run}@test.example>`;
    await sql`insert into ticket_messages (workspace_id, ticket_id, role, author_label, body, external_message_id)
      values (${workspaceId}, ${ticket.id}, 'agent', 'Agent', 'Help', ${parent})`;
    const result = await inbound({ workspaceId: otherWorkspace, payload: payload(email, parent) });
    expect(result.threaded).toBe(false); expect(result.ticket_id).not.toBe(ticket.id);
    await assertSpam(result.ticket_id);
    expect((await sql`select status_key from tickets where id = ${ticket.id}`)[0].status_key).toBe('resolved');
  });

  it('cannot change another workspace’s contact or ticket and does not filter the same email there', async () => {
    expect((await request(`/customers/${customerId}/spam`, 'DELETE', undefined, otherWorkspace)).status).toBe(404);
    expect((await request(`/tickets/${ticketId}/close`, 'POST', { reason: 'spam' }, otherWorkspace)).status).toBe(404);
    expect((await request('/customers/not-a-uuid/spam', 'DELETE')).status).toBe(404);
    const result = await inbound({ workspaceId: otherWorkspace, payload: payload() });
    expect((await sql`select status_key from tickets where id = ${result.ticket_id}`)[0].status_key).toBe('open');
    expect(result.auto_triage_queued).toBe(true);
  });

  it('undo restores normal incoming mail without reopening historical spam tickets', async () => {
    expect((await request(`/customers/${customerId}/spam`, 'DELETE')).status).toBe(200);
    expect((await sql`select is_spam from customers where id = ${customerId}`)[0].is_spam).toBe(false);
    await assertSpam(ticketId);
    const result = await inbound({ workspaceId, payload: payload(secondary) });
    expect((await sql`select status_key from tickets where id = ${result.ticket_id}`)[0].status_key).toBe('open');
    const threaded = await inbound({ workspaceId, payload: payload(email, originalId) });
    expect(threaded.ticket_id).toBe(ticketId);
    expect((await sql`select status_key from tickets where id = ${ticketId}`)[0].status_key).toBe('open');
  });

  it('does not mark the contact if a survey is already sending; can mark an already-closed ticket', async () => {
    await sql`update tickets set csat_send_claim = ${crypto.randomUUID()}, csat_send_started_at = now() where id = ${ticketId}`;
    expect((await request(`/tickets/${ticketId}/close`, 'POST', { reason: 'spam' })).status).toBe(409);
    expect((await sql`select is_spam from customers where id = ${customerId}`)[0].is_spam).toBe(false);
    await sql`update tickets set csat_send_claim = null, csat_send_started_at = null where id = ${ticketId}`;
    expect((await request(`/tickets/${ticketId}/close`, 'POST', { reason: 'duplicate', note: 'Original decision' })).status).toBe(200);
    expect((await request(`/tickets/${ticketId}/close`, 'POST', { reason: 'spam' })).status).toBe(200);
    await assertSpam(ticketId);
    expect((await sql`select body from ticket_messages where ticket_id = ${ticketId} and body like '%Original decision%'`).length).toBeGreaterThan(0);
  });

  it('preserves spam filtering when contacts move during a merge', async () => {
    const [target] = await sql`insert into customers (workspace_id, display_id, first_name, email)
      values (${workspaceId}, 'MERGE-SPAM-C', 'Survivor', ${'survivor-' + email}) returning id`;
    const merged = await request(`/customers/${customerId}/merge`, 'POST', { into_id: target.id });
    expect(merged.status).toBe(200);
    expect((await merged.json() as any).primary.is_spam).toBe(true);
    const result = await inbound({ workspaceId, payload: payload(secondary) });
    await assertSpam(result.ticket_id); expect(result.customer_id).toBe(target.id);
    expect((await request(`/customers/${target.id}/spam`, 'DELETE')).status).toBe(200);
    const allowed = await inbound({ workspaceId, payload: payload(email) });
    expect((await sql`select status_key from tickets where id = ${allowed.ticket_id}`)[0].status_key).toBe('open');
  });
});
