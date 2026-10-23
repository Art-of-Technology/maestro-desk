import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { authorizeRoleRequest, effectivePermissions, permissionKeys, userCanViewTicket } from './lib/role-permissions.js';

describe('role permission defaults', () => {
  it('preserves legacy access, denies missing explicit grants, and protects admin access', () => {
    expect(effectivePermissions({})['customers.contact_remove']).toBe(true);
    expect(effectivePermissions({})['tools.templates']).toBe(false);
    expect(effectivePermissions({ can_delete: true })['customers.merge']).toBe(true);
    expect(effectivePermissions({ can_delete: true, permissions: {} })['customers.merge']).toBe(false);
    expect(Object.values(effectivePermissions({ is_admin: true, permissions: {} })).every(Boolean)).toBe(true);
    expect(Object.values(effectivePermissions({ permissions: {} }, true)).every(Boolean)).toBe(true);
  });
  it('preserves multipart bytes while checking attachment permissions', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('rolePermissions', effectivePermissions({ is_admin: true }));
      await authorizeRoleRequest(c); await next();
    });
    app.post('/api/v1/tickets/:id/attachments', async c => {
      const file = (await c.req.formData()).get('file') as File;
      return c.json([...new Uint8Array(await file.arrayBuffer())]);
    });
    const bytes = [0xff, 0x00, 0xfe, 0x80, 0x41];
    const form = new FormData(); form.set('file', new File([new Uint8Array(bytes)], 'synthetic.bin'));
    const response = await app.request('/api/v1/tickets/12345678-1234-1234-1234-123456789abc/attachments', { method: 'POST', body: form });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(bytes);
  });
});

const run = process.env.RUN_DB_TESTS ? describe : describe.skip;
run('saved role permissions (isolated database)', () => {
  let app: typeof import('./index.js').default, sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let ws: string, otherWs: string, roleId: string, adminRole: string, foreignRole: string;
  let admin: { id: string; token: string }, agent: { id: string; token: string };
  let ownTicket: string, otherTicket: string, customer: string, secondary: string;
  const stamp = Date.now();
  const grants = (keys: string[] = []) => Object.fromEntries(permissionKeys.map(key => [key, keys.includes(key)]));
  async function request(token: string, path: string, method = 'GET', body?: unknown, workspace = ws) {
    return app.request('/api/v1/' + path, { method,
      headers: { Authorization: 'Bearer ' + token, 'X-Workspace-Id': workspace, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function snapshot() {
    const result = await request(admin.token, 'roles');
    expect(result.status).toBe(200);
    return (await result.json() as any).roles.find((row: any) => row.id === roleId);
  }
  async function save(permissions: Record<string, boolean>, version?: number) {
    const row = await snapshot();
    return request(admin.token, 'roles/permissions', 'PUT', {
      roles: [{ id: roleId, version: version ?? row.permissions_version, permissions }], new_roles: [],
    });
  }
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    async function signup(name: string) {
      const result: any = await auth.api.signUpEmail({ body: { email: `matrix-${name}-${stamp}@test.test`, name, password: 'synthetic-test-password-123' }, returnHeaders: true });
      return { id: result.response.user.id, token: result.response.token };
    }
    admin = await signup('admin'); agent = await signup('agent');
    [{ id: ws }] = await sql`select provision_brand(${'matrix-' + stamp}, ${'matrix-' + stamp}) as id`;
    [{ id: otherWs }] = await sql`select provision_brand(${'matrix-other-' + stamp}, ${'matrix-other-' + stamp}) as id`;
    [{ id: adminRole }] = await sql`select id from roles where workspace_id=${ws} and is_admin limit 1`;
    [{ id: roleId }] = await sql`select id from roles where workspace_id=${ws} and name='Senior Agent'`;
    [{ id: foreignRole }] = await sql`select id from roles where workspace_id=${otherWs} and not is_admin limit 1`;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${ws},${admin.id},${adminRole},true),(${ws},${agent.id},${roleId},true)`;
    [{ id: customer }] = await sql`insert into customers(workspace_id,display_id,first_name,email)
      values(${ws},'MATRIX-C','Synthetic',${'matrix-c-' + stamp + '@test.test'}) returning id`;
    [{ id: ownTicket }] = await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key,assigned_user_id)
      values(${ws},'MATRIX-OWN','Synthetic own',${customer},'open','normal',${agent.id}) returning id`;
    [{ id: otherTicket }] = await sql`insert into tickets(workspace_id,display_id,subject,customer_id,status_key,priority_key,assigned_user_id)
      values(${ws},'MATRIX-OTHER','Synthetic other',${customer},'open','normal',${admin.id}) returning id`;
    const contact = await request(agent.token, `customers/${customer}/contacts`, 'POST', { kind: 'email', value: `matrix-alt-${stamp}@test.test` });
    expect(contact.status).toBe(201); secondary = (await contact.json() as any).contact.id;
  }, 30000);
  afterAll(async () => {
    if (!sql) return;
    if (ws) await sql`delete from workspaces where id=${ws}`;
    if (otherWs) await sql`delete from workspaces where id=${otherWs}`;
    if (admin && agent) await sql`delete from users where id in (${admin.id},${agent.id})`;
  });

  it('requires brand admin access and rejects unknown permission keys', async () => {
    expect((await request(agent.token, 'roles/permissions', 'PUT', { roles: [], new_roles: [] })).status).toBe(403);
    const row = await snapshot();
    expect((await request(admin.token, 'roles/permissions', 'PUT', {
      roles: [{ id: roleId, version: row.permissions_version, permissions: { ...grants(), 'platform.admin': true } }], new_roles: [],
    })).status).toBe(400);
  });
  it('saves atomically, rejects cross-brand roles, and preserves the old snapshot on failure', async () => {
    const before = await snapshot();
    const response = await request(admin.token, 'roles/permissions', 'PUT', {
      roles: [{ id: roleId, version: before.permissions_version, permissions: grants() }, { id: foreignRole, version: 0, permissions: grants() }],
      new_roles: [],
    });
    expect(response.status).toBe(409);
    expect((await snapshot()).permissions_version).toBe(before.permissions_version);
    expect((await snapshot()).permissions['customers.contact_remove']).toBe(true);
  });
  it('makes saved restrictions effective for an already signed-in agent', async () => {
    const permissions = grants(['tickets.view_assigned', 'customers.view', 'customers.contact_add']);
    expect((await save(permissions)).status).toBe(200);
    const identity = await request(agent.token, 'whoami');
    expect((await identity.json() as any).memberships.find((member: any) => member.workspace_id === ws).permissions_legacy).toBe(false);
    expect((await request(agent.token, `customers/${customer}/contacts/${secondary}`, 'DELETE')).status).toBe(403);
    expect((await request(agent.token, `tickets/${ownTicket}/messages`, 'POST', { role: 'agent', body: 'Synthetic' })).status).toBe(403);
    expect(await userCanViewTicket(ws, agent.id, ownTicket)).toBe(true);
    expect(await userCanViewTicket(ws, agent.id, otherTicket)).toBe(false);
    const [audit] = await sql`select metadata from audit_events where workspace_id=${ws}
      and action='role.permissions_saved' order by created_at desc limit 1`;
    expect(audit.metadata.changes[0].role_id).toBe(roleId);
    expect(audit.metadata.changes[0].revoked).toContain('customers.contact_remove');
  });
  it('filters ticket lists and readable links, and blocks brand-wide secondary paths', async () => {
    for (const path of ['tickets', 'tickets/work-index', 'tickets/sync?cursor=2000-01-01T00:00:00Z']) {
      const response = await request(agent.token, path); expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.tickets.map((row: any) => row.id)).toContain(ownTicket);
      expect(body.tickets.map((row: any) => row.id)).not.toContain(otherTicket);
    }
    expect((await request(agent.token, `tickets/${otherTicket}`)).status).toBe(404);
    expect((await request(agent.token, 'tickets/by-number/MATRIX-OTHER')).status).toBe(404);
    for (const path of [`customers/${customer}/summary`, 'reports/dashboard', 'activity']) expect((await request(agent.token, path)).status).toBe(403);
    expect((await request(agent.token, 'pubby/auth', 'POST', { socket_id: '1.2', channel_name: 'private-test' })).status).toBe(403);
    expect((await request(agent.token, `presence/ticket/${otherTicket}`, 'POST', {})).status).toBe(404);
    expect((await request(agent.token, 'tickets', 'GET', undefined, otherWs)).status).toBe(403);
  });
  it('rejects stale saves and creates new roles with only the saved grants', async () => {
    const before = await snapshot();
    expect((await save(grants(['tickets.view_assigned']))).status).toBe(200);
    expect((await save(grants(['tickets.view_all']), before.permissions_version)).status).toBe(409);
    const permissions = grants(['customers.view']);
    const response = await request(admin.token, 'roles/permissions', 'PUT', { roles: [], new_roles: [{ name: 'Synthetic new role', permissions }] });
    expect(response.status).toBe(200);
    const created = (await response.json() as any).roles.find((row: any) => row.name === 'Synthetic new role');
    expect(created.permissions).toEqual(permissions);
    const duplicate = await request(admin.token, 'roles/permissions', 'PUT', { roles: [{ id: roleId, version: (await snapshot()).permissions_version, permissions: grants() }], new_roles: [{ name: 'Synthetic new role', permissions }] });
    expect(duplicate.status).toBe(409);
    expect((await snapshot()).permissions['tickets.view_assigned']).toBe(true);
  });
  it('protects admin roles and prevents delegated access escalation', async () => {
    expect((await request(admin.token, 'roles/permissions', 'PUT', { roles: [{ id: adminRole, version: 0, permissions: grants() }], new_roles: [] })).status).toBe(409);
    expect((await request(admin.token, `roles/${adminRole}`, 'PATCH', { is_admin: false })).status).toBe(409);
    expect((await request(admin.token, `agents/${admin.id}`, 'PATCH', { active: false })).status).toBe(404);
    expect((await save(grants(['admin.assign_roles', 'admin.agents']))).status).toBe(200);
    expect((await request(agent.token, `agents/${agent.id}`, 'PATCH', { role_id: adminRole })).status).toBe(403);
    expect((await request(agent.token, 'roles/permissions', 'PUT', { roles: [], new_roles: [] })).status).toBe(403);
    expect((await request(agent.token, 'tickets')).status).toBe(403);
  });
  it('keeps primary-email and custom GDPR-status permissions separate from ordinary edits', async () => {
    expect((await save(grants(['tickets.view_all', 'tickets.create', 'tickets.edit', 'customers.view', 'customers.contact_add']))).status).toBe(200);
    expect((await request(agent.token, `customers/${customer}/contacts`, 'POST', { kind: 'email', value: `matrix-primary-${stamp}@test.test`, primary: true })).status).toBe(403);
    expect((await request(agent.token, `tickets/${ownTicket}`, 'PATCH', { status_option_key: 'pending' })).status).toBe(200);
    expect((await request(agent.token, `tickets/${ownTicket}`, 'PATCH', { status_option_key: 'resolved' })).status).toBe(403);
    const created = await request(admin.token, 'ticket-statuses', 'POST', { label: 'Synthetic privacy', base_key: 'gdpr', send_survey: false });
    expect(created.status).toBe(201);
    const key = (await created.json() as any).status.key;
    expect((await request(agent.token, `tickets/${ownTicket}`, 'PATCH', { status_option_key: key })).status).toBe(403);
    expect((await request(agent.token, 'tickets', 'POST', { subject: 'Synthetic', customer_id: customer, status_option_key: key })).status).toBe(403);
    const resolved = await request(admin.token, 'ticket-statuses', 'POST', { label: 'Synthetic resolved', base_key: 'resolved', send_survey: false });
    expect(resolved.status).toBe(201);
    const resolvedKey = (await resolved.json() as any).status.key;
    const closed = await request(admin.token, `tickets/${ownTicket}`, 'PATCH', { status_option_key: resolvedKey });
    expect(closed.status).toBe(200);
    expect((await closed.json() as any).ticket.status_key).toBe('resolved');
    expect((await request(agent.token, `tickets/${ownTicket}`, 'PATCH', { status_option_key: 'open' })).status).toBe(403);
    expect((await request(admin.token, `tickets/${ownTicket}`, 'PATCH', { status_option_key: 'pending' })).status).toBe(200);
  });
  it('audit sanitisation keeps known grants and discards arbitrary text', async () => {
    const [row] = await sql`select audit_metadata_facts('role.permissions_saved', ${sql.json({
      changes: [{ role_id: roleId, granted: [...permissionKeys, 'private text'], revoked: ['customers.contact_remove'], name: 'private text' }],
      created: [roleId, 'private text'], name: 'private text',
    })}::jsonb) as facts`;
    expect(row.facts).toEqual({ changes: [{ role_id: roleId, granted: permissionKeys, revoked: ['customers.contact_remove'] }], created: [roleId] });
  });
  it('does not trust Content-Type for JSON permission checks', async () => {
    expect((await save(grants(['tickets.view_assigned', 'tickets.create', 'tickets.reply', 'customers.view', 'customers.contact_add', 'tools.ai']))).status).toBe(200);
    const { anthropic } = await import('./lib/anthropic.js');
    const provider = spyOn(anthropic.messages, 'create').mockRejectedValue(new Error('Synthetic provider guard'));
    try {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
        const headers = new Headers({ Authorization: 'Bearer ' + agent.token, 'X-Workspace-Id': ws });
        if (type) headers.set('Content-Type', type);
        for (const [path, method, body, expected] of [
          [`tickets/${ownTicket}`, 'PATCH', { assigned_user_id: admin.id }, 403],
          [`tickets/${ownTicket}`, 'PATCH', { priority_key: 'urgent' }, 403],
          [`tickets/${ownTicket}`, 'PATCH', { status_option_key: 'resolved' }, 403],
          [`tickets/${ownTicket}/messages`, 'POST', { role: 'note', body: 'Synthetic note' }, 403],
          ['tickets', 'POST', { subject: 'Synthetic', customer_id: customer, assigned_user_id: admin.id }, 403],
          ['tickets', 'POST', { subject: 'Synthetic', customer_id: customer, status_option_key: 'gdpr' }, 403],
          [`customers/${customer}/contacts`, 'POST', { kind: 'email', value: `spoof-${stamp}@test.test`, primary: true }, 403],
          ['ai/messages', 'POST', { action: 'draft', ticketId: otherTicket, model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Synthetic' }] }, 404],
          ['ai/messages', 'POST', { action: 'similar_reply', ticketId: ownTicket, model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Synthetic' }] }, 403],
        ] as const) {
          const response = await app.request('/api/v1/' + path, { method, headers, body: JSON.stringify(body) });
          expect(response.status).toBe(expected);
        }
      }
      expect(provider).not.toHaveBeenCalled();
    } finally { provider.mockRestore(); }
  });
  it('requires a real role and fails closed for a role from another brand', async () => {
    for (const [role, expected] of [[null, '23502'], [crypto.randomUUID(), '23503']] as const) {
      let code: string | undefined;
      try { await sql`update workspace_members set role_id=${role} where workspace_id=${ws} and user_id=${agent.id}`; }
      catch (err) { code = (err as { code?: string }).code; }
      expect(code).toBe(expected);
    }
    await sql`update workspace_members set role_id=${foreignRole} where workspace_id=${ws} and user_id=${agent.id}`;
    try {
      expect((await request(agent.token, 'tickets')).status).toBe(403);
    } finally { await sql`update workspace_members set role_id=${roleId} where workspace_id=${ws} and user_id=${agent.id}`; }
  });
});
