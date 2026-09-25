import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

process.env.BETTER_AUTH_SECRET ||= 'note-edit-test-secret-at-least-32-characters';
process.env.ANTHROPIC_API_KEY ||= 'note-edit-test-anthropic-key';
process.env.POSTMARK_INBOUND_SECRET ||= 'note-edit-test-inbound-secret';
const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('admin note editing', () => {
  let app: typeof import('./index.js').default, sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let workspace: string, other: string, admin: any, agent: any;
  const suffix = randomUUID();
  beforeAll(async () => {
    app = (await import('./index.js')).default; sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    admin = await auth.api.signUpEmail({ body: { email: `note-admin-${suffix}@t.test`, password: 'password-12345', name: 'Admin' } });
    agent = await auth.api.signUpEmail({ body: { email: `note-agent-${suffix}@t.test`, password: 'password-12345', name: 'Author' } });
    for (const key of ['own', 'other']) {
      const [ws] = await sql`select provision_brand(${'Note test ' + key}, ${'note-' + key + suffix}) as id`;
      if (key === 'own') workspace = ws.id; else other = ws.id;
      for (const [user, isAdmin] of [[admin, true], [agent, false]] as const) {
        const [role] = await sql`select id from roles where workspace_id = ${ws.id} and is_admin = ${isAdmin} limit 1`;
        await sql`insert into workspace_members(workspace_id, user_id, role_id) values (${ws.id}, ${user.user.id}, ${role.id})`;
      }
    }
  }, 30000);
  afterAll(async () => {
    for (const ws of [workspace, other].filter(Boolean)) await sql`delete from workspaces where id = ${ws}`;
    for (const user of [admin, agent].filter(Boolean)) await sql`delete from users where id = ${user.user.id}`;
  }, 30000);
  const request = (kind: string, parent: string, note: string, body: any, token = admin.token, ws = workspace) =>
    app.request(`/api/v1/${kind}/${parent}/${kind === 'tickets' ? 'messages' : 'notes'}/${note}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const history = (kind: string, parent: string, note: string, token = admin.token, ws = workspace) =>
    app.request(`/api/v1/${kind}/${parent}/${kind === 'tickets' ? 'messages' : 'notes'}/${note}/history`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws },
    });
  async function fixture(kind: string, role = 'note') {
    const [customer] = await sql`insert into customers(workspace_id, display_id, first_name)
      values (${workspace}, ${'M-' + randomUUID()}, 'Note test') returning id`;
    if (kind === 'customers') {
      const [note] = await sql`insert into customer_notes(workspace_id, customer_id, author_user_id, text)
        values (${workspace}, ${customer.id}, ${agent.user.id}, 'Original') returning *`;
      return { parent: customer.id, note };
    }
    const [ticket] = await sql`insert into tickets(workspace_id, display_id, customer_id, subject, status_key, priority_key)
      values (${workspace}, ${'TK-' + randomUUID()}, ${customer.id}, 'Note test', 'open', 'normal') returning id`;
    const [note] = await sql`insert into ticket_messages(workspace_id, ticket_id, author_user_id, author_label, role, body)
      values (${workspace}, ${ticket.id}, ${agent.user.id}, 'Author', ${role}, 'Original') returning *`;
    await sql`insert into ticket_attachments(workspace_id, ticket_id, message_id, filename, storage_key)
      values (${workspace}, ${ticket.id}, ${note.id}, 'test.txt', 'test-only')`;
    return { parent: ticket.id, note };
  }
  for (const kind of ['tickets', 'customers']) {
    it(`${kind}: admins edit with an audit, preserving author, timestamp and attachments`, async () => {
      const { parent, note } = await fixture(kind);
      const res = await request(kind, parent, note.id, { text: 'Edited', original_text: 'Original' });
      expect(res.status).toBe(200);
      const { note: updated }: any = await res.json();
      expect(updated.author_user_id).toBe(agent.user.id);
      expect(new Date(updated.created_at).getTime()).toBe(new Date(note.created_at).getTime());
      expect(updated[kind === 'tickets' ? 'body' : 'text']).toBe('Edited');
      const [audit] = await sql`select * from audit_events where workspace_id = ${workspace} and target_id = ${note.id}`;
      expect(audit.actor_user_id).toBe(admin.user.id); expect(audit.action).toBe(kind === 'tickets' ? 'ticket_note.edited' : 'customer_note.edited');
      if (kind === 'tickets') {
        const files = await sql`select * from ticket_attachments where message_id = ${note.id}`;
        expect(files).toHaveLength(1);
      }
      expect((await request(kind, parent, note.id, { text: 'Stale', original_text: 'Original' })).status).toBe(409);
    });
    it(`${kind}: denies non-admins, other workspaces, wrong parents and invalid text`, async () => {
      const { parent, note } = await fixture(kind);
      const body = { text: 'Edited', original_text: 'Original' };
      expect((await request(kind, parent, note.id, body, agent.token)).status).toBe(403);
      expect((await request(kind, parent, note.id, body, admin.token, other)).status).toBe(404);
      expect((await request(kind, randomUUID(), note.id, body)).status).toBe(404);
      expect((await request(kind, parent, note.id, { ...body, text: ' ' })).status).toBe(400);
      expect((await request(kind, parent, note.id, { ...body, text: 'x'.repeat(kind === 'tickets' ? 100001 : 4001) })).status).toBe(400);
      expect((await request(kind, parent, 'invalid', body)).status).toBe(404);
      const audits = await sql`select id from audit_events where target_id = ${note.id}`;
      expect(audits).toHaveLength(0);
      if (kind === 'tickets') await sql`update ticket_messages set deleted_at = now() where id = ${note.id}`;
      else await sql`update customer_notes set deleted_at = now() where id = ${note.id}`;
      expect((await request(kind, parent, note.id, body)).status).toBe(404);
    });
  }
  for (const kind of ['tickets', 'customers']) {
    it(`${kind}: history records both versions, editor, time and audit link; admin/workspace scoped`, async () => {
      const { parent, note } = await fixture(kind);
      for (const [before, after] of [['Original', '<First edit>'], ['<First edit>', 'Second edit']]) {
        expect((await request(kind, parent, note.id, { text: after, original_text: before })).status).toBe(200);
      }
      const response = await history(kind, parent, note.id); expect(response.status).toBe(200);
      const { revisions }: any = await response.json();
      expect(revisions.map((r: any) => [r.before_text, r.after_text])).toEqual([['<First edit>', 'Second edit'], ['Original', '<First edit>']]);
      for (const revision of revisions) {
        expect(revision.editor_user_id).toBe(admin.user.id); expect(revision.editor_label).toBe('Admin');
        expect(Number.isNaN(new Date(revision.created_at).getTime())).toBe(false);
        const [audit] = await sql`select metadata from audit_events where target_id = ${note.id} and metadata->>'revision_id' = ${revision.id}`;
        expect(audit.metadata.revision_id).toBe(revision.id);
        expect(JSON.stringify(audit.metadata)).not.toContain('First edit');
      }
      expect((await history(kind, parent, note.id, agent.token)).status).toBe(403);
      expect((await history(kind, parent, note.id, admin.token, other)).status).toBe(404);
      expect((await history(kind, randomUUID(), note.id)).status).toBe(404);
      const { exportCustomer } = await import('./lib/gdpr-export.js');
      const { eraseCustomer } = await import('./lib/gdpr-erasure.js');
      const customerId = kind === 'customers' ? parent : (await sql`select customer_id from tickets where id = ${parent}`)[0].customer_id;
      const bundle = await exportCustomer({ workspaceId: workspace, customerId });
      expect(bundle?.note_revisions).toHaveLength(2);
      await eraseCustomer({ workspaceId: workspace, customerId, requestedByUserId: admin.user.id }, { deleteObjects: async () => {} });
      expect((await exportCustomer({ workspaceId: workspace, customerId }))?.note_revisions).toHaveLength(0);
      expect(await sql`select id from note_revisions where ticket_message_id = ${note.id} or customer_note_id = ${note.id}`).toHaveLength(0);
      expect(await sql`select id from audit_events where target_id = ${note.id}`).toHaveLength(2);
      expect((await request(kind, parent, note.id, { text: 'After erasure', original_text: '[erased]' })).status).toBe(404);
    });
    it(`${kind}: a failed revision insert rolls back the edit and audit`, async () => {
      const { parent, note } = await fixture(kind);
      const constraint = 'reject_revision_' + note.id.replaceAll('-', '');
      await sql.unsafe(`alter table note_revisions add constraint ${constraint} check (coalesce(ticket_message_id, customer_note_id) <> '${note.id}'::uuid)`);
      try {
        expect((await request(kind, parent, note.id, { text: 'Must roll back', original_text: 'Original' })).status).toBe(500);
        const rows = kind === 'tickets' ? await sql`select body as text from ticket_messages where id = ${note.id}`
          : await sql`select text from customer_notes where id = ${note.id}`;
        expect(rows[0].text).toBe('Original');
        expect(await sql`select id from audit_events where target_id = ${note.id}`).toHaveLength(0);
      } finally { await sql.unsafe(`alter table note_revisions drop constraint ${constraint}`); }
    });
  }
  it('cannot edit customer messages or public replies through the internal-note endpoint', async () => {
    for (const role of ['customer', 'agent', 'ai', 'system']) {
      const { parent, note } = await fixture('tickets', role);
      expect((await request('tickets', parent, note.id, { text: 'Changed', original_text: 'Original' })).status).toBe(404);
    }
  });
});
