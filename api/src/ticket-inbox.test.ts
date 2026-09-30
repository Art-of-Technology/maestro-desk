import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('ticket inbox moves', () => {
  let app: typeof import('./index.js').default, sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, other: string, user: string, token: string, ticket: string, source: string;
  let first: string, second: string, foreign: string, inactive: string, nonEmail: string;
  const suffix = randomUUID();
  const request = (path: string, method = 'GET', body?: unknown, workspace = ws) => app.request('/api/v1/' + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace, 'Content-Type': 'application/json',
      'X-Forwarded-For': '2001:db8:586:' + suffix.slice(0, 4) + '::1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const current = async () => (await (await request('tickets/' + ticket)).json() as any).ticket;
  const move = (channel: string | null, before: any, workspace = ws) => request(`tickets/${ticket}/inbox`, 'PATCH', {
    channel_id: channel, expected_channel_id: before.channel_id, expected_updated_at: before.updated_at,
  }, workspace);
  beforeAll(async () => {
    app = (await import('./index.js')).default; sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signed: any = await auth.api.signUpEmail({ body: { email: `inbox-${suffix}@t.test`, password: 'password-12345', name: 'Inbox Agent' } });
    user = signed.user.id; token = signed.token;
    [ws, other] = await Promise.all(['a', 'b'].map(async part => {
      const [w] = await sql`select provision_brand(${'Inbox ' + part}, ${'inbox-' + part + '-' + suffix}) as id`;
      const [role] = await sql`select id from roles where workspace_id=${w.id} and is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${w.id},${user},${role.id})`;
      return w.id;
    }));
    const domain = `inbox-${suffix}.test`;
    await sql`insert into workspace_email_domains(workspace_id,domain,verified_at) values (${ws},${domain},now())`;
    const channel = async (name: string, workspace = ws, status = 'active', type = 'email') => {
      const [row] = await sql`insert into channels(workspace_id,display_id,name,type,address,status)
        values (${workspace},${name},${name},${type},${name.toLowerCase() + '@' + domain},${status}) returning id`;
      return row.id;
    };
    first = await channel('Support'); second = await channel('Payments'); foreign = await channel('Foreign', other);
    inactive = await channel('Inactive', ws, 'inactive'); nonEmail = await channel('Chat', ws, 'active', 'chat');
    const [customer] = await sql`insert into customers(workspace_id,display_id,first_name,email)
      values (${ws},'C1','Customer','customer@example.test') returning id`;
    const [t] = await sql`insert into tickets(workspace_id,display_id,customer_id,subject,status_key,priority_key,channel_id)
      values (${ws},'TK-1',${customer.id},'Inbox test','open','normal',${first}) returning id`;
    ticket = t.id;
    const [message] = await sql`insert into ticket_messages(workspace_id,ticket_id,role,author_label,body,email_metadata)
      values (${ws},${ticket},'customer','Customer','Please help',${sql.json({ from: 'customer@example.test', to: ['support@' + domain],
        status: 'received', received_via: 'support@' + domain })}) returning id`;
    source = message.id;
  }, 30000);
  afterAll(async () => {
    if (!sql) return;
    for (const id of [ws, other].filter(Boolean)) await sql`delete from workspaces where id=${id}`;
    if (user) await sql`delete from users where id=${user}`;
  });
  it('moves atomically, records history, changes the default sender and preserves the received email', async () => {
    const before = await current();
    const result = await move(second, before); expect(result.status).toBe(200);
    const saved: any = await result.json();
    expect(saved.ticket.channel_id).toBe(second);
    expect(saved.activity[0].details).toContain('Support'); expect(saved.activity[0].details).toContain('Payments');
    const after = await current();
    expect(after.reply_recipients.default_sending_channel_id).toBe(second);
    expect(after.messages.find((m: any) => m.id === source).email_metadata).toEqual(before.messages.find((m: any) => m.id === source).email_metadata);
    const [audit] = await sql`select metadata from audit_events where workspace_id=${ws} and action='ticket.inbox.changed'`;
    expect(audit.metadata.before).toBe(first); expect(audit.metadata.after).toBe(second);
    const list: any = await (await request('tickets')).json();
    expect(list.tickets.find((t: any) => t.id === ticket).channel_id).toBe(second);
    const delta: any = await (await request('tickets/sync?cursor=' + encodeURIComponent('2020-01-01T00:00:00Z|'))).json();
    expect(delta.tickets.find((t: any) => t.id === ticket).channel_id).toBe(second);
    expect((await move(first, saved.ticket)).status).toBe(200);
    expect((await current()).channel_id).toBe(first);
    expect((await move(second, before)).status).toBe(409);
  });
  it('rejects foreign, inactive, deleted and non-email channels and foreign tickets', async () => {
    const before = await current();
    for (const id of [foreign, inactive, nonEmail, randomUUID()]) expect((await move(id, before)).status).toBe(400);
    expect((await move(second, before, other)).status).toBe(404);
    await sql`update channels set deleted_at=now() where id=${second}`;
    expect((await move(second, before)).status).toBe(400);
    await sql`update channels set deleted_at=null where id=${second}`;
    expect((await current()).channel_id).toBe(first);
  });
  it('allows only one concurrent move and does not let stale Undo replace newer changes', async () => {
    const before = await current();
    const results = await Promise.all([move(second, before), move(null, before)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const after = await current();
    expect((await move(first, after)).status).toBe(200);
    expect((await move(first, after)).status).toBe(409);
  });
  it('backfills a recorded original inbox without overwriting an existing assignment', async () => {
    await sql`insert into inbox_messages(workspace_id,channel_id,external_id,from_email,subject,received_at,status,converted_ticket_id)
      values (${ws},${first},${suffix},'customer@example.test','Inbox test',now(),'converted',${ticket})`;
    const migration = readFileSync(new URL('../../db/migrations/20260930130000_ticket_inbox.sql', import.meta.url), 'utf8');
    await sql`update tickets set channel_id=null where id=${ticket}`;
    await sql.unsafe(migration); expect((await current()).channel_id).toBe(first);
    await sql`update tickets set channel_id=${second} where id=${ticket}`;
    await sql.unsafe(migration); expect((await current()).channel_id).toBe(second);
  });
  it('rolls back the move if its audit record cannot be saved', async () => {
    const constraint = 'inbox_audit_' + suffix.replaceAll('-', '');
    const before = await current();
    await sql.unsafe(`alter table audit_events add constraint ${constraint} check (workspace_id <> '${ws}'::uuid or action <> 'ticket.inbox.changed') not valid`);
    try {
      expect((await move(first, before)).status).toBe(500);
      expect((await current()).channel_id).toBe(before.channel_id);
    } finally { await sql.unsafe(`alter table audit_events drop constraint ${constraint}`); }
  });
});
