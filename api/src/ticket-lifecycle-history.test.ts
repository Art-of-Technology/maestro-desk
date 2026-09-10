import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { applyAssignmentRules } from './lib/assign-rules-engine.js';
import { reopenOnCustomerReply } from './lib/reopen-customer-reply.js';

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('ticket lifecycle history', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, other: string, user: string, second: string, token: string, customer: string;
  const suffix = randomUUID();
  const request = (id: string, path = '', method = 'GET', body?: unknown, workspace = ws) => app.request(`/api/v1/tickets/${id}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace,
      'X-Forwarded-For': `2001:db8:506:${suffix.slice(0, 4)}::1`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const makeTicket = async (status = 'pending') => {
    const [t] = await sql`insert into tickets(workspace_id, display_id, customer_id, subject, status_key, priority_key)
      values (${ws}, ${'TK-' + randomUUID()}, ${customer}, 'Lifecycle history test', ${status}, 'normal') returning id`;
    return t.id as string;
  };
  const audits = (id: string) => sql`select actor_user_id, action, metadata from audit_events
    where workspace_id = ${ws} and target_id = ${id} order by seq`;
  const bodyOf = async (response: Response) => { expect(response.status).toBe(200); return response.json() as Promise<any>; };
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({ body: { email: `lifecycle-${suffix}@t.test`, password: 'password-12345', name: 'Lifecycle Agent' } });
    user = signed.user.id; token = signed.token;
    const another: any = await auth.api.signUpEmail({ body: { email: `lifecycle-other-${suffix}@t.test`, password: 'password-12345', name: 'Second Agent' } });
    second = another.user.id;
    [ws, other] = await Promise.all(['a', 'b'].map(async part => {
      const [r] = await sql`select provision_brand(${'Lifecycle ' + part}, ${'lifecycle-' + part + '-' + suffix}) as id`;
      const [role] = await sql`select id from roles where workspace_id = ${r.id} and is_admin limit 1`;
      for (const member of [user, second]) await sql`insert into workspace_members(workspace_id, user_id, role_id) values (${r.id}, ${member}, ${role.id})`;
      return r.id;
    }));
    const [c] = await sql`insert into customers(workspace_id, display_id, first_name) values (${ws}, 'M1', 'Lifecycle') returning id`;
    customer = c.id;
  }, 30000);
  afterAll(async () => {
    if (!sql) return;
    for (const id of [ws, other].filter(Boolean)) await sql`delete from workspaces where id = ${id}`;
    for (const id of [user, second].filter(Boolean)) await sql`delete from users where id = ${id}`;
  });

  it('serializes status changes and ignores unchanged retries', async () => {
    const id = await makeTicket();
    const responses = await Promise.all(['open', 'escalated'].map(status_key => request(id, '', 'PATCH', { status_key })));
    for (const r of responses) expect((await bodyOf(r)).activity).toHaveLength(1);
    const history = await audits(id);
    expect(history).toHaveLength(2);
    expect(history[0].metadata.before).toBe('pending');
    expect(history[1].metadata.before).toBe(history[0].metadata.after);
    expect(history.every(h => h.actor_user_id === user)).toBe(true);
    expect((await bodyOf(await request(id, '', 'PATCH', { status_key: history[1].metadata.after }))).activity).toHaveLength(0);
    const detail = await bodyOf(await request(id));
    expect(detail.ticket.activity).toHaveLength(2);
  });

  it('keeps closure details, clears snooze once, and audits customer reopening once', async () => {
    const id = await makeTicket();
    await bodyOf(await request(id, '/snooze', 'POST', { until: new Date(Date.now() + 3600000).toISOString(), reason: 'Waiting' }));
    const closed = await bodyOf(await request(id, '/close', 'POST', { reason: 'other', note: 'Preserve this decision' }));
    expect(closed.activity.map((e: any) => e.kind)).toEqual(['status', 'snooze']);
    expect((await bodyOf(await request(id, '/close', 'POST', { reason: 'spam' }))).activity).toHaveLength(0);
    await Promise.all([1, 2].map(() => sql.begin(tx => reopenOnCustomerReply(tx, ws, id))));
    const detail = await bodyOf(await request(id));
    expect(detail.ticket.status_key).toBe('open');
    const notes = await sql`select body from ticket_messages where ticket_id = ${id} and role = 'note'`;
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain('Preserve this decision');
    expect(notes[0].body).toContain(user);
    expect(notes[0].body).toContain(new Date(closed.ticket.closed_at).toISOString());
    const history = await audits(id);
    expect(history).toHaveLength(4);
    expect(history[1].metadata.context).toEqual({ reason: 'other', note: 'Preserve this decision' });
    expect(history[3].actor_user_id).toBeNull();
    expect(history[3].metadata.source).toBe('customer_reply');
    expect(history[3].metadata.before).toBe('closed');
  });

  it('audits pending and resolved customer reopening without attributing it to an agent', async () => {
    for (const status of ['pending', 'resolved']) {
      const id = await makeTicket(status);
      await sql.begin(tx => reopenOnCustomerReply(tx, ws, id));
      const [a] = await audits(id);
      expect(a.metadata.before).toBe(status);
      expect(a.metadata.after).toBe('open');
      expect(a.metadata.actor_label).toBe('Customer reply');
      expect(a.actor_user_id).toBeNull();
    }
  });

  it('records snooze reason changes, ignores retries and rejects stale wakeups', async () => {
    const id = await makeTicket(), until = new Date(Date.now() + 3600000).toISOString();
    const save = (reason: string) => request(id, '/snooze', 'POST', { until, reason });
    await bodyOf(await save('First reason'));
    const retry = await bodyOf(await save('First reason'));
    expect(retry.activity).toHaveLength(0);
    const changed = await bodyOf(await save('Second reason'));
    expect(changed.activity).toHaveLength(1);
    const early = await bodyOf(await request(id, '/snooze?via_wakeup=true', 'DELETE'));
    expect(early.activity).toHaveLength(0);
    expect(new Date(early.ticket.snoozed_until).toISOString()).toBe(until);
    const cleared = await bodyOf(await request(id, '/snooze', 'DELETE'));
    expect(cleared.activity[0].author_user_id).toBe(user);
    expect(cleared.ticket.snoozed_until).toBeNull();
    expect((await bodyOf(await request(id, '/snooze', 'DELETE'))).activity).toHaveLength(0);
    const history = await audits(id);
    expect(history).toHaveLength(3);
    expect(JSON.parse(history[1].metadata.before).reason).toBe('First reason');
    expect(JSON.parse(history[1].metadata.after).reason).toBe('Second reason');
  });

  it('records concurrent expiry once using the system actor and preserves the wake timestamp', async () => {
    const id = await makeTicket();
    await sql`update tickets set snoozed_until = now() - interval '1 minute', snooze_reason = 'Expired' where id = ${id}`;
    const results = await Promise.all([1, 2, 3].map(async () => bodyOf(await request(id, '/snooze?via_wakeup=true', 'DELETE'))));
    expect(results.flatMap(r => r.activity)).toHaveLength(1);
    expect(new Set(results.map(r => r.ticket.snooze_woken_at)).size).toBe(1);
    const [a] = await audits(id);
    expect(a.actor_user_id).toBeNull();
    expect(a.metadata.source).toBe('snooze_expired');
  });

  it('serializes reverse merges and records merge/unmerge status with the original actor', async () => {
    const a = await makeTicket(), b = await makeTicket();
    const responses = await Promise.all([request(a, '/merge', 'POST', { into_id: b }), request(b, '/merge', 'POST', { into_id: a })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const index = responses.findIndex(r => r.status === 200), source = [a, b][index];
    expect((await responses[index].json() as any).activity).toHaveLength(1);
    const unmerged = await bodyOf(await request(source, '/unmerge', 'POST', {}));
    expect(unmerged.source.status_key).toBe('pending');
    const history = await audits(source);
    expect(history.map(h => h.metadata.source)).toEqual(['merge', 'unmerge']);
    expect(history.every(h => h.actor_user_id === user)).toBe(true);
  });

  it('keeps assignment and round-robin bookkeeping atomic across simultaneous tickets', async () => {
    const [rule] = await sql`insert into assign_rules(workspace_id, display_id, name, priority, conditions, assignment)
      values (${ws}, 'AR506', 'Round robin original name', 1, ${sql.json({})},
      ${sql.json({ mode: 'round-robin', team_user_ids: [user, second], rr_index: 0 })}) returning id`;
    try {
      const ids = await Promise.all([makeTicket(), makeTicket()]);
      const results = await Promise.all(ids.map(ticketId => applyAssignmentRules({ workspaceId: ws, ticketId })));
      expect(new Set(results.map(r => r?.assigned_user_id)).size).toBe(2);
      const [saved] = await sql`select match_count, assignment from assign_rules where id = ${rule.id}`;
      expect(saved.match_count).toBe(2);
      expect(saved.assignment.rr_index).toBe(0);
      await sql`update assign_rules set name = 'Renamed rule', assignment = ${sql.json({ mode: 'specific-agent', agent_user_id: user })} where id = ${rule.id}`;
      const id = ids.find((_, i) => results[i]?.assigned_user_id === second)!;
      const applied = await bodyOf(await request(id, '/apply-rules', 'POST', {}));
      expect(applied.activity[0].author_user_id).toBe(user);
      expect(applied.ticket.assigned_user_id).toBe(user);
      expect((await bodyOf(await request(id, '/apply-rules', 'POST', {}))).activity).toHaveLength(0);
      const history = await audits(id);
      expect(history[0].actor_user_id).toBeNull();
      expect(history[0].metadata.context).toEqual({ rule_id: rule.id, rule_name: 'Round robin original name' });
      expect(history[1].metadata.context.rule_name).toBe('Renamed rule');
      expect(history[1].metadata.before).toBe(second);
    } finally { await sql`delete from assign_rules where id = ${rule.id}`; }
  });

  it('rolls back status, closure, snooze, merge and assignment if audit persistence fails', async () => {
    const constraint = 'lifecycle_failure_' + suffix.replaceAll('-', '');
    await sql.unsafe(`alter table audit_events add constraint ${constraint} check (workspace_id <> '${ws}'::uuid) not valid`);
    let rule: string | undefined;
    try {
      const id = await makeTicket(), target = await makeTicket();
      for (const [path, method, body] of [
        ['', 'PATCH', { status_key: 'open' }], ['/close', 'POST', { reason: 'other', note: 'Must roll back' }],
        ['/snooze', 'POST', { until: new Date(Date.now() + 3600000).toISOString() }], ['/merge', 'POST', { into_id: target }],
      ] as const) expect((await request(id, path, method, body)).status).toBe(500);
      const [r] = await sql`insert into assign_rules(workspace_id, display_id, name, priority, conditions, assignment)
        values (${ws}, 'AR507', 'Rollback rule', 1, ${sql.json({})}, ${sql.json({ mode: 'specific-agent', agent_user_id: user })}) returning id`;
      rule = r.id;
      await expect(applyAssignmentRules({ workspaceId: ws, ticketId: id })).rejects.toThrow();
      await expect(sql.begin(tx => reopenOnCustomerReply(tx, ws, id))).rejects.toThrow();
      const [saved] = await sql`select status_key, closure_note, snoozed_until, merged_into_id, assigned_user_id from tickets where id = ${id}`;
      expect(saved).toMatchObject({ status_key: 'pending', closure_note: null, snoozed_until: null, merged_into_id: null, assigned_user_id: null });
      expect(await sql`select id from ticket_messages where ticket_id in (${id}, ${target})`).toHaveLength(0);
      expect(await sql`select id from events where entity_id = ${id}`).toHaveLength(0);
      const [bookkeeping] = await sql`select match_count from assign_rules where id = ${rule!}`;
      expect(bookkeeping.match_count || 0).toBe(0);
    } finally {
      await sql.unsafe(`alter table audit_events drop constraint ${constraint}`);
      if (rule) await sql`delete from assign_rules where id = ${rule}`;
    }
  });

  it('isolates lifecycle writes and history between workspaces; verifies the audit chain', async () => {
    const id = await makeTicket(), target = await makeTicket();
    for (const [path, method, body] of [
      ['', 'PATCH', { status_key: 'open' }], ['/close', 'POST', { reason: 'other' }],
      ['/snooze', 'POST', { until: new Date(Date.now() + 3600000).toISOString() }], ['/snooze', 'DELETE', undefined],
      ['/merge', 'POST', { into_id: target }], ['/unmerge', 'POST', {}],
    ] as const) expect((await request(id, path, method, body, other)).status).toBe(404);
    expect(await applyAssignmentRules({ workspaceId: other, ticketId: id })).toBeNull();
    await sql.begin(tx => reopenOnCustomerReply(tx, other, id));
    expect(await audits(id)).toHaveLength(0);
    const filtered = await app.request('/api/v1/activity?kind=snooze', { headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws } });
    const feed = await bodyOf(filtered);
    expect(feed.events.length).toBeGreaterThan(0);
    expect(feed.events.every((e: any) => e.kind === 'snooze')).toBe(true);
    const [verified] = await sql`select ok from audit_events_verify(${ws})`;
    expect(verified.ok).toBe(true);
  });
});
