import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('canned response API', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const users: { id: string; token: string }[] = [];
  const workspaces: string[] = [];
  const run = Date.now();
  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    for (let i = 0; i < 2; i++) {
      const r: any = await auth.api.signUpEmail({ body: { email: `template-${run}-${i}@t.test`, password: 'password-12345', name: 'Template test' }, returnHeaders: true });
      users.push({ id: r.response.user.id, token: r.response.token });
      const [{ ws }] = await sql`select provision_brand(${'template-' + run + '-' + i}, ${'template-' + run + '-' + i}) as ws`;
      workspaces.push(ws);
    }
    const [admin] = await sql`select id from roles where workspace_id = ${workspaces[0]} and is_admin = true limit 1`;
    const [agent] = await sql`select id from roles where workspace_id = ${workspaces[0]} and name = 'Read Only' limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${workspaces[0]}, ${users[0].id}, ${admin.id}, true), (${workspaces[0]}, ${users[1].id}, ${agent.id}, true)`;
    const [otherAdmin] = await sql`select id from roles where workspace_id = ${workspaces[1]} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${workspaces[1]}, ${users[0].id}, ${otherAdmin.id}, true)`;
  });
  afterAll(async () => {
    for (const id of workspaces) await sql`delete from workspaces where id = ${id}`;
    for (const user of users) await sql`delete from users where id = ${user.id}`;
  });
  function request(method: string, id = '', body?: object, user = 0, workspace = 0) {
    return app.request('/api/v1/canned-responses' + (id ? '/' + id : ''), { method,
      headers: { Authorization: `Bearer ${users[user].token}`, 'X-Workspace-Id': workspaces[workspace], 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  it('round-trips rich HTML; renames retain HTML; legacy edits clear it', async () => {
    const create = await request('POST', '', { name: 'Rich', body: '', body_html: '<p>Hello <strong>{name}</strong></p>' });
    expect(create.status).toBe(201);
    const { canned_response: row } = await create.json() as any;
    expect(row.body).toBe('Hello {name}');
    const rename = await request('PATCH', row.id, { name: 'Renamed' });
    expect((await rename.json() as any).canned_response.body_html).toBe(row.body_html);
    expect((await request('PATCH', row.id, { body_html: null })).status).toBe(400);
    const plain = await request('PATCH', row.id, { body: 'Old client edit' });
    expect((await plain.json() as any).canned_response.body_html).toBeNull();
    expect((await request('GET')).status).toBe(200);
    expect((await request('DELETE', row.id)).status).toBe(204);
  });
  it('blocks non-admin mutations and cross-workspace reads/writes', async () => {
    const created = await request('POST', '', { name: 'Private', body: 'Hello' });
    const { canned_response: row } = await created.json() as any;
    expect((await request('POST', '', { name: 'No', body: 'No' }, 1)).status).toBe(403);
    expect((await request('PATCH', row.id, { body: 'No' }, 1)).status).toBe(403);
    expect((await request('DELETE', row.id, undefined, 1)).status).toBe(403);
    expect((await request('PATCH', row.id, { body: 'No' }, 0, 1)).status).toBe(404);
    const list = await request('GET', '', undefined, 0, 1);
    expect((await list.json() as any).canned_responses.some((r: any) => r.id === row.id)).toBe(false);
    await request('DELETE', row.id, undefined, 0, 1);
    expect((await sql`select id from canned_responses where id = ${row.id}`).length).toBe(1);
  });
});
