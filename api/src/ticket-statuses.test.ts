import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { reopenOnCustomerReply } from './lib/reopen-customer-reply.js';
import { sendCsatSurvey } from './lib/csat-survey.js';

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('brand ticket status options', () => {
  let app: typeof import('./index.js').default, sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, other: string, customer: string, user: string, agent: string, token: string, agentToken: string;
  const suffix = randomUUID();
  const request = (path: string, method = 'GET', body?: unknown, workspace = ws, auth = token) => app.request('/api/v1/' + path, {
    method, headers: { Authorization: `Bearer ${auth}`, 'X-Workspace-Id': workspace, 'Content-Type': 'application/json', 'X-Forwarded-For': '2001:db8:590::1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (response: Response, code = 200): Promise<any> => { expect(response.status).toBe(code); return response.json(); };
  const option = async (base_key = 'resolved', send_survey = false) => (await json(await request('ticket-statuses', 'POST', { label: `Choice ${randomUUID()}`, base_key, send_survey }), 201)).status;
  const ticket = async () => {
    const [t] = await sql`insert into tickets(workspace_id, display_id, subject, customer_id, status_key, priority_key)
      values(${ws}, ${randomUUID()}, 'Status test', ${customer}, 'open', 'normal') returning id`;
    return t.id as string;
  };
  const state = async (id: string) => (await sql`select status_key, status_option_key, status_survey_enabled, resolved_at from tickets where id=${id} and workspace_id=${ws}`)[0];
  beforeAll(async () => {
    app = (await import('./index.js')).default; sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const owner: any = await auth.api.signUpEmail({ body: { email: `statuses-owner-${suffix}@t.test`, password: 'password-12345', name: 'Status Owner' } });
    const member: any = await auth.api.signUpEmail({ body: { email: `statuses-agent-${suffix}@t.test`, password: 'password-12345', name: 'Status Agent' } });
    user = owner.user.id; token = owner.token; agent = member.user.id; agentToken = member.token;
    const spaces = [];
    for (const part of ['a', 'b']) {
      const [w] = await sql`select provision_brand(${'Statuses ' + part}, ${'statuses-' + part + '-' + suffix}) as id`;
      const [adminRole] = await sql`select id from roles where workspace_id=${w.id} and is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id, user_id, role_id) values(${w.id},${user},${adminRole.id})`;
      spaces.push(w.id);
    }
    [ws, other] = spaces;
    const [role] = await sql`select id from roles where workspace_id=${ws} and not is_admin limit 1`;
    await sql`insert into workspace_members(workspace_id, user_id, role_id) values(${ws},${agent},${role.id})`;
    const [c] = await sql`insert into customers(workspace_id, display_id, first_name) values(${ws},'M1','Status customer') returning id`;
    customer = c.id;
  }, 30000);
  afterAll(async () => {
    if (!sql) return;
    for (const id of [ws, other].filter(Boolean)) await sql`delete from workspaces where id=${id}`;
    for (const id of [user, agent].filter(Boolean)) await sql`delete from users where id=${id}`;
  });

  it('seeds defaults, lets agents read, and restricts configuration to their brand admins', async () => {
    const defaults = await json(await request('ticket-statuses', 'GET', undefined, ws, agentToken));
    expect(defaults.statuses.find((s: any) => s.key === 'resolved').send_survey).toBe(true);
    expect(defaults.statuses.find((s: any) => s.key === 'closed')).toMatchObject({ reason_required: true, reasons: expect.arrayContaining([expect.objectContaining({ key: 'spam', is_active: true })]) });
    expect((await request('ticket-statuses', 'POST', { label: 'Forbidden', base_key: 'resolved', send_survey: false }, ws, agentToken)).status).toBe(403);
    const choice = await option();
    const [created] = await sql`select metadata from audit_events where workspace_id=${ws} and action='ticket_status.created' order by seq desc limit 1`;
    expect(created.metadata).toMatchObject({ key: choice.key, base_key: 'resolved', send_survey: false });
    expect(created.metadata.label).toBeUndefined();
    expect((await request(`ticket-statuses/${choice.key}`, 'PUT', { label: 'Wrong brand', send_survey: false, is_active: true }, other)).status).toBe(404);
    expect((await request('ticket-statuses', 'POST', { label: 'Invalid', base_key: 'closed', send_survey: true })).status).toBe(400);
    expect((await request('ticket-statuses/resolved', 'PUT', { label: 'Resolved', send_survey: true, is_active: false })).status).toBe(400);
  });

  it('resolves without a survey, blocks manual sending, and retains resolution time between resolved variants', async () => {
    const never = await option(), another = await option(), id = await ticket();
    const result = await json(await request(`tickets/${id}`, 'PATCH', { status_option_key: never.key }));
    expect(result.ticket.status_key).toBe('resolved'); expect(result.survey.reason).toBe('disabled_by_status');
    const [audit] = await sql`select metadata from audit_events where workspace_id=${ws} and target_id=${id} and action='ticket.status.changed' order by seq desc limit 1`;
    expect(audit.metadata).toMatchObject({ before: 'open', after: 'resolved', after_option: never.key });
    const first = await state(id);
    expect(first.status_survey_enabled).toBe(false); expect(first.resolved_at).not.toBeNull();
    expect((await json(await request(`tickets/${id}/csat`, 'POST'))).survey.reason).toBe('disabled_by_status');
    expect((await sendCsatSurvey({ workspaceId: ws, ticketId: id }))).toEqual({ sent: false, reason: 'disabled_by_status' });
    await json(await request(`tickets/${id}`, 'PATCH', { status_option_key: another.key }));
    expect((await state(id)).resolved_at.toISOString()).toBe(first.resolved_at.toISOString());
    expect((await json(await request(`tickets/${id}`, 'PATCH', { status_option_key: another.key }))).activity).toHaveLength(0);
    const [history] = await sql`select details from events where entity_id=${id} and workspace_id=${ws} order by created_at desc limit 1`;
    expect(history.details).toContain(another.label);
  });

  it('setting edits affect future selections and retirement preserves history while rejecting new choices', async () => {
    const choice = await option(), id = await ticket();
    await json(await request(`tickets/${id}`, 'PATCH', { status_option_key: choice.key }));
    await json(await request(`ticket-statuses/${choice.key}`, 'PUT', { label: 'Renamed outcome', send_survey: true, is_active: true }));
    const [changed] = await sql`select metadata from audit_events where workspace_id=${ws} and action='ticket_status.updated' order by seq desc limit 1`;
    expect(changed.metadata).toMatchObject({ key: choice.key, label_changed: true, before: { send_survey: false }, after: { send_survey: true } });
    expect((await state(id)).status_survey_enabled).toBe(false);
    const fresh = await ticket();
    await json(await request(`tickets/${fresh}`, 'PATCH', { status_option_key: choice.key }));
    expect((await state(fresh)).status_survey_enabled).toBe(true);
    await json(await request(`ticket-statuses/${choice.key}`, 'PUT', { label: 'Renamed outcome', send_survey: true, is_active: false }));
    expect((await request(`tickets/${await ticket()}`, 'PATCH', { status_option_key: choice.key })).status).toBe(400);
    expect((await state(id)).status_option_key).toBe(choice.key);
  });

  it('rejects wrong-brand choices, mismatched categories and closing without a reason', async () => {
    const closed = await option('closed'), id = await ticket();
    expect((await request(`tickets/${id}`, 'PATCH', { status_option_key: closed.key })).status).toBe(400);
    expect((await request(`tickets/${id}/close`, 'POST', { status_option_key: closed.key })).status).toBe(400);
    const result = await json(await request(`tickets/${id}/close`, 'POST', { status_option_key: closed.key, reason: 'duplicate' }));
    expect(result.ticket.status_option_key).toBe(closed.key); expect(result.ticket.closure_reason).toBe('duplicate');
    const foreign = (await json(await request('ticket-statuses', 'POST', { label: 'Foreign', base_key: 'pending', send_survey: false }, other), 201)).status;
    const fresh = await ticket();
    expect((await request(`tickets/${fresh}`, 'PATCH', { status_option_key: foreign.key })).status).toBe(400);
    expect((await request(`tickets/${fresh}`, 'PATCH', { status_option_key: closed.key, status_key: 'resolved' })).status).toBe(400);
    expect((await request('tickets', 'POST', { subject: 'Invalid closure', customer_id: customer, status_option_key: closed.key })).status).toBe(400);
  });

  it('enforces per-status reasons and preserves recorded labels after renaming and retirement', async () => {
    const reasons = [{ key: 'awaiting-documents', label: 'Awaiting documents', is_active: true }];
    const choice = (await json(await request('ticket-statuses', 'POST', { label: 'Waiting for documents', base_key: 'pending', send_survey: false, reason_required: true, reasons }), 201)).status;
    const id = await ticket();
    expect((await request(`tickets/${id}`, 'PATCH', { status_option_key: choice.key })).status).toBe(400);
    expect((await request(`tickets/${id}`, 'PATCH', { status_option_key: choice.key, status_reason: 'duplicate' })).status).toBe(400);
    const result = await json(await request(`tickets/${id}`, 'PATCH', { status_option_key: choice.key, status_reason: reasons[0].key }));
    expect(result.activity[0].details).toContain('Reason: Awaiting documents');
    await json(await request(`ticket-statuses/${choice.key}`, 'PUT', { label: choice.label, send_survey: false, is_active: true, reason_required: false,
      reasons: [{ ...reasons[0], label: 'Documents requested', is_active: false }] }));
    const [saved] = await sql`select status_reason, status_reason_label from tickets where id=${id}`;
    expect(saved).toMatchObject({ status_reason: 'awaiting-documents', status_reason_label: 'Awaiting documents' });
    expect((await request(`tickets/${await ticket()}`, 'PATCH', { status_option_key: choice.key, status_reason: reasons[0].key })).status).toBe(400);
    await json(await request(`tickets/${await ticket()}`, 'PATCH', { status_option_key: choice.key }));
    expect((await request(`ticket-statuses/${choice.key}`, 'PUT', { label: choice.label, send_survey: false, is_active: true, reasons: [] })).status).toBe(400);
  });

  it('allows optional closure without a reason and custom closure reasons without changing spam semantics', async () => {
    const choice = (await json(await request('ticket-statuses', 'POST', { label: 'Administrative close', base_key: 'closed', send_survey: false, reason_required: false,
      reasons: [{ key: 'test-account', label: 'Test account', is_active: true }] }), 201)).status;
    const noReason = await json(await request(`tickets/${await ticket()}/close`, 'POST', { status_option_key: choice.key }));
    expect(noReason.ticket.closure_reason).toBeNull();
    const result = await json(await request(`tickets/${await ticket()}/close`, 'POST', { status_option_key: choice.key, reason: 'test-account' }));
    expect(result.ticket.closure_reason).toBe('test-account'); expect(result.ticket.status_reason_label).toBe('Test account');
    await json(await request(`ticket-statuses/${choice.key}`, 'PUT', { label: choice.label, send_survey: false, is_active: true, reasons: [{ key: 'test-account', label: 'Renamed reason', is_active: false }] }));
    await sql.begin(tx => reopenOnCustomerReply(tx, ws, result.ticket.id));
    const [history] = await sql`select body from ticket_messages where ticket_id=${result.ticket.id} and role='note'`;
    expect(history.body).toContain('Reason: Test account');
    expect((await request('ticket-statuses/closed', 'PUT', { label: 'Closed', send_survey: false, is_active: true, reason_required: false, reasons: [] })).status).toBe(400);
  });

  it('rejects invalid configuration and enforces reasons for API ticket creation', async () => {
    for (const reasons of [[], [{ key: 'same', label: 'One', is_active: true }, { key: 'same', label: 'Two', is_active: true }]]) {
      expect((await request('ticket-statuses', 'POST', { label: 'Invalid', base_key: 'pending', send_survey: false, reason_required: true, reasons })).status).toBe(400);
    }
    const choice = (await json(await request('ticket-statuses', 'POST', { label: 'Needs reason', base_key: 'pending', send_survey: false, reason_required: true,
      reasons: [{ key: 'review', label: 'Review needed', is_active: true }] }), 201)).status;
    expect((await request('tickets', 'POST', { subject: 'Missing reason', customer_id: customer, status_option_key: choice.key })).status).toBe(400);
    const created = await json(await request('tickets', 'POST', { subject: 'With reason', customer_id: customer, status_option_key: choice.key, status_reason: 'review' }), 201);
    const [saved] = await sql`select status_reason_label from tickets where id=${created.ticket.id}`;
    expect(saved.status_reason_label).toBe('Review needed');
  });

  it('customer replies restore the built-in open choice and active survey claims prevent silent status changes', async () => {
    const choice = await option(), id = await ticket();
    await json(await request(`tickets/${id}`, 'PATCH', { status_option_key: choice.key }));
    await sql.begin(tx => reopenOnCustomerReply(tx, ws, id));
    expect((await state(id)).status_option_key).toBe('open'); expect((await state(id)).resolved_at).toBeNull();
    await sql`update tickets set status_key='resolved' where id=${id} and workspace_id=${ws}`;
    await sql`update tickets set csat_send_claim=${randomUUID()}, csat_send_started_at=now() where id=${id} and workspace_id=${ws}`;
    expect((await request(`tickets/${id}`, 'PATCH', { status_option_key: choice.key })).status).toBe(409);
    await sql`update tickets set csat_send_claim=null, csat_send_started_at=null where id=${id} and workspace_id=${ws}`;
  });

  it('macros validate active status references and must be updated before retirement', async () => {
    const choice = await option('pending');
    await json(await request('macros', 'POST', { name: 'Use custom status', actions: [{ kind: 'status', value: choice.key }] }), 201);
    expect((await request(`ticket-statuses/${choice.key}`, 'PUT', { label: choice.label, send_survey: false, is_active: false })).status).toBe(409);
    expect((await request('macros', 'POST', { name: 'Invalid status', actions: [{ kind: 'status', value: 'missing' }] })).status).toBe(400);
  });

  it('saves custom status filters and creates tickets without changing their reporting category', async () => {
    const choice = await option('pending');
    await json(await request('saved-searches', 'POST', { name: 'Custom status', filters: { status: choice.key } }), 201);
    const result = await json(await request('tickets', 'POST', { subject: 'Custom creation', customer_id: customer, status_option_key: choice.key }), 201);
    expect((await state(result.ticket.id)).status_key).toBe('pending');
    expect((await state(result.ticket.id)).status_option_key).toBe(choice.key);
    const legacy = await json(await request('tickets', 'POST', { subject: 'Template default', customer_id: customer }), 201);
    expect((await state(legacy.ticket.id)).status_option_key).toBe('open');
  });

  it('merge and unmerge restore retired choices and their original survey policy', async () => {
    for (const category of ['pending', 'resolved']) {
      const choice = await option(category), id = await ticket(), primary = await ticket();
      await json(await request(`tickets/${id}`, 'PATCH', { status_option_key: choice.key }));
      const original = await state(id);
      const merged = await json(await request(`tickets/${id}/merge`, 'POST', { into_id: primary }));
      expect(merged.source.status_key).toBe('resolved');
      await json(await request(`ticket-statuses/${choice.key}`, 'PUT', { label: choice.label, send_survey: category === 'resolved', is_active: false }));
      const restored = await json(await request(`tickets/${id}/unmerge`, 'POST'));
      expect(restored.source.status_key).toBe(category);
      expect(restored.source.status_option_key).toBe(choice.key);
      expect(restored.source.status_survey_enabled).toBe(false);
      expect((await state(id)).resolved_at).toEqual(original.resolved_at);
    }
  });

  it('serialises status retirement with macro saves and ticket selections', async () => {
    const choice = await option('pending');
    const [macro, retire] = await Promise.all([
      request('macros', 'POST', { name: 'Concurrent macro', actions: [{ kind: 'status', value: choice.key }] }),
      request(`ticket-statuses/${choice.key}`, 'PUT', { label: choice.label, send_survey: false, is_active: false }),
    ]);
    expect([201, 400]).toContain(macro.status); expect([200, 409]).toContain(retire.status);
    expect(macro.status === 201 && retire.status === 200).toBe(false);
    const another = await option('pending'), id = await ticket();
    const [selected, retired] = await Promise.all([
      request(`tickets/${id}`, 'PATCH', { status_option_key: another.key }),
      request(`ticket-statuses/${another.key}`, 'PUT', { label: another.label, send_survey: false, is_active: false }),
    ]);
    expect([200, 400]).toContain(selected.status); expect(retired.status).toBe(200);
    expect((await state(id)).status_option_key).toBe(selected.status === 200 ? another.key : 'open');
  });
});
