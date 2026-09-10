import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('permanent ticket history', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, other: string, user: string, token: string, ticket: string;
  const suffix = randomUUID(), ip = '2001:db8:503:' + suffix.slice(0, 4) + '::1';
  const request = (path: string, method = 'GET', body?: unknown, workspace = ws) => app.request('/api/v1/' + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace,
      'X-Forwarded-For': ip, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const patch = (body: unknown) => request('tickets/' + ticket, 'PATCH', body);
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({ body: { email: `history-${suffix}@t.test`, password: 'password-12345', name: 'Original Agent' } });
    user = signed.user.id; token = signed.token;
    [ws, other] = await Promise.all(['a', 'b'].map(async part => {
      const [r] = await sql`select provision_brand(${'History ' + part}, ${'history-' + part + '-' + suffix}) as id`;
      const [role] = await sql`select id from roles where workspace_id = ${r.id} and is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id, user_id, role_id) values (${r.id}, ${user}, ${role.id})`;
      return r.id;
    }));
    const [customer] = await sql`insert into customers(workspace_id, display_id, first_name)
      values (${ws}, 'M1', 'History') returning id`;
    const [t] = await sql`insert into tickets(workspace_id, display_id, customer_id, subject, status_key, priority_key)
      values (${ws}, 'TK-503', ${customer.id}, 'History acceptance', 'pending', 'normal') returning id`;
    ticket = t.id;
  }, 30000);
  afterAll(async () => {
    if (!sql) return;
    for (const id of [ws, other].filter(Boolean)) await sql`delete from workspaces where id = ${id}`;
    if (user) await sql`delete from users where id = ${user}`;
  });

  it('stores both fields with verified actor and previous/new values; no-op retries add nothing', async () => {
    const response = await patch({ assigned_user_id: user, priority_key: 'high' });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.activity).toHaveLength(2);
    expect(body.activity.every((e: any) => e.author_user_id === user && e.author_label === 'Original Agent')).toBe(true);
    expect((await patch({ assigned_user_id: user, priority_key: 'high' })).status).toBe(200);
    const audits = await sql`select metadata from audit_events where workspace_id = ${ws} order by seq`;
    expect(audits).toHaveLength(2);
    expect(audits[0].metadata.before).toBe('normal');
    expect(audits[0].metadata.after).toBe('high');
    expect(audits[1].metadata.before).toBeNull();
    expect(audits[1].metadata.after).toBe(user);
    expect(audits[1].metadata.after_label).toBe('Original Agent');
  });
  it('keeps recorded names after renaming an agent and reloads ticket history', async () => {
    await sql`update users set name = 'Renamed Agent' where id = ${user}`;
    const body: any = await (await request('tickets/' + ticket)).json();
    expect(body.ticket.activity).toHaveLength(2);
    expect(body.ticket.activity.every((e: any) => e.author_label === 'Original Agent')).toBe(true);
    expect(body.ticket.activity.some((e: any) => e.details.includes('Original Agent'))).toBe(true);
  });
  it('serializes concurrent priorities and identical tag retries accurately', async () => {
    const results = await Promise.all([patch({ priority_key: 'low' }), patch({ priority_key: 'normal' })]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    const history = await sql`select metadata from audit_events where workspace_id = ${ws}
      and action = 'ticket.priority.changed' order by seq`;
    expect(history).toHaveLength(3);
    expect(history[1].metadata.before).toBe('high');
    expect(history[2].metadata.before).toBe(history[1].metadata.after);
    const [t] = await sql`select priority_key from tickets where id = ${ticket}`;
    expect(history[2].metadata.after).toBe(t.priority_key);
    const tags = await Promise.all([1, 2, 3].map(() => request(`tickets/${ticket}/tags`, 'POST', { tag: 'Audit Retry' })));
    expect(tags.map(r => r.status)).toEqual([201, 201, 201]);
    const events = await sql`select id from events where workspace_id = ${ws} and kind = 'tag'`;
    expect(events).toHaveLength(1);
    expect((await request(`tickets/${ticket}/tags/audit-retry`, 'DELETE')).status).toBe(204);
    expect((await request(`tickets/${ticket}/tags/audit-retry`, 'DELETE')).status).toBe(204);
    const audit = await sql`select metadata from audit_events where workspace_id = ${ws} and action = 'ticket.tag.changed' order by seq`;
    expect(audit).toHaveLength(2);
    expect(audit[1].metadata.before).toBe('audit-retry');
    expect(audit[1].metadata.after).toBeNull();
  });
  it('rolls back the change and activity if the audit insert fails', async () => {
    const constraint = 'history_failure_' + suffix.replaceAll('-', '');
    await sql.unsafe(`alter table audit_events add constraint ${constraint} check (workspace_id <> '${ws}'::uuid or action <> 'ticket.priority.changed') not valid`);
    try {
      const [before] = await sql`select priority_key from tickets where id = ${ticket}`;
      const events = await sql`select id from events where workspace_id = ${ws}`;
      expect((await patch({ priority_key: 'urgent' })).status).toBe(500);
      const [after] = await sql`select priority_key from tickets where id = ${ticket}`;
      expect(after.priority_key).toBe(before.priority_key);
      expect(await sql`select id from events where workspace_id = ${ws}`).toHaveLength(events.length);
    } finally { await sql.unsafe(`alter table audit_events drop constraint ${constraint}`); }
  });
  it('scopes writes, detail history and the feed to the authenticated workspace', async () => {
    expect((await request('tickets/' + ticket, 'GET', undefined, other)).status).toBe(404);
    expect((await request('tickets/' + ticket, 'PATCH', { priority_key: 'urgent' }, other)).status).toBe(404);
    expect((await request(`tickets/${ticket}/tags`, 'POST', { tag: 'foreign' }, other)).status).toBe(404);
    const empty: any = await (await request('activity?ticket=' + ticket, 'GET', undefined, other)).json();
    expect(empty.events).toEqual([]);
    expect((await app.request('/api/v1/activity')).status).toBe(401);
  });
  it('pages saved history without duplicates, filters on the server, rejects invalid cursors', async () => {
    let cursor: string | null = null;
    const ids = [];
    do {
      const response = await request('activity?limit=1&ticket=' + ticket + (cursor ? '&cursor=' + cursor : ''));
      expect(response.status).toBe(200);
      const body: any = await response.json();
      ids.push(...body.events.map((e: any) => e.id)); cursor = body.next_cursor;
      if (ids.length > 20) throw new Error('Cursor did not advance');
    } while (cursor);
    expect(ids).toHaveLength(7); // six changes plus creation
    expect(new Set(ids).size).toBe(ids.length);
    const filtered: any = await (await request('activity?kind=agent&q=Original')).json();
    expect(filtered.events).toHaveLength(1);
    expect((await request('activity?cursor=bad')).status).toBe(400);
    expect((await request('activity?limit=101')).status).toBe(400);
    const [verified] = await sql`select ok from audit_events_verify(${ws})`;
    expect(verified.ok).toBe(true);
  });
  it('records accepting an AI suggestion once, including its promotion to a ticket tag', async () => {
    await sql`insert into ticket_ai_tags(workspace_id, ticket_id, tag, confidence)
      values (${ws}, ${ticket}, 'suggestion', 90)`;
    const first: any = await (await request(`tickets/${ticket}/ai_tags/suggestion`, 'PATCH', { accepted: true })).json();
    expect(first.activity).toHaveLength(1);
    const retry: any = await (await request(`tickets/${ticket}/ai_tags/suggestion`, 'PATCH', { accepted: true })).json();
    expect(retry.activity).toHaveLength(0);
  });
});
