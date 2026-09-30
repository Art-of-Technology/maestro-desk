import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('persistent workspace libraries', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const workspaces: string[] = [], users: string[] = [], tokens: string[] = [];
  const json = async (response: Response): Promise<any> => response.json();
  const request = (who: number, ws: number, path: string, method = 'GET', body?: unknown) => app.request('/api/v1/' + path, {
    method, headers: { Authorization: 'Bearer ' + tokens[who], 'X-Workspace-Id': workspaces[ws], 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    for (let i = 0; i < 3; i++) {
      const session = await auth.api.signUpEmail({ body: { email: `libraries-${Date.now()}-${i}@test.invalid`, password: 'password-12345', name: 'Library tester' } });
      users.push(session.user.id); tokens.push(session.token!);
      if (i < 2) {
        const [ws] = await sql`select provision_brand('Library test', ${'libraries-' + crypto.randomUUID()}) as id`;
        workspaces.push(ws.id);
      }
      const ws = workspaces[i === 2 ? 0 : i];
      const [role] = i === 2
        ? await sql`insert into roles (workspace_id, name, is_admin) values (${ws}, 'Library member', false) returning id`
        : await sql`select id from roles where workspace_id=${ws} and name='Admin'`;
      await sql`insert into workspace_members (workspace_id, user_id, role_id, active) values (${ws}, ${users[i]}, ${role.id}, true)`;
    }
  }, 30000);
  afterAll(async () => {
    if (workspaces.length) await sql`delete from workspaces where id in ${sql(workspaces)}`;
    if (users.length) await sql`delete from users where id in ${sql(users)}`;
  });

  it('persists tag creation and edits, rejects duplicates and restricts management to admins', async () => {
    expect((await request(2, 0, 'tags', 'POST', { tag: 'blocked' })).status).toBe(403);
    expect((await request(0, 0, 'tags', 'POST', { tag: '!!!' })).status).toBe(400);
    expect((await request(0, 0, 'tags', 'POST', { tag: ' Welcome Offer ' })).status).toBe(201);
    expect((await request(0, 0, 'tags', 'POST', { tag: 'welcome-offer' })).status).toBe(409);
    expect((await json(await request(2, 0, 'tags'))).tags).toContainEqual({ tag: 'welcome-offer', kind: 'manual', ai_confidence: null, count: 0 });
    expect((await json(await request(1, 1, 'tags'))).tags).toHaveLength(0);
    expect((await request(1, 1, 'tags/welcome-offer', 'PATCH', { kind: 'ai' })).status).toBe(404);
    expect((await request(2, 0, 'tags/welcome-offer', 'PATCH', { tag: 'renamed' })).status).toBe(403);
    expect((await request(0, 0, 'tags/welcome-offer', 'PATCH', { tag: 'free-spins', kind: 'ai', ai_confidence: 0 })).status).toBe(200);
    expect((await json(await request(0, 0, 'tags'))).tags[0]).toMatchObject({ tag: 'free-spins', ai_confidence: 0 });
    expect((await request(0, 0, 'tags/free-spins', 'DELETE')).status).toBe(204);
    expect((await json(await request(0, 0, 'tags'))).tags).toHaveLength(0);
  });

  it('persists macros and usage, validates reply ownership and isolates CRUD by workspace', async () => {
    const templates = [];
    for (const ws of workspaces) {
      const [t] = await sql`insert into canned_responses (workspace_id, display_id, name, body)
        values (${ws}, 'TPL-1', 'Reply', 'Hello') returning id`;
      templates.push(t.id);
    }
    const body = { name: 'Waiting', actions: [{ kind: 'status', value: 'pending' }, { kind: 'reply', templateId: templates[0] }] };
    expect((await request(2, 0, 'macros', 'POST', body)).status).toBe(403);
    expect((await request(0, 0, 'macros', 'POST', { ...body, workspace_id: workspaces[1] })).status).toBe(400);
    expect((await request(0, 0, 'macros', 'POST', { ...body, actions: [{ kind: 'reply', templateId: templates[1] }] })).status).toBe(400);
    const created = await request(0, 0, 'macros', 'POST', body);
    expect(created.status).toBe(201);
    const { macro } = await json(created);
    expect((await json(await request(2, 0, 'macros'))).macros[0]).toMatchObject({ id: macro.id, actions: body.actions });
    expect((await json(await request(1, 1, 'macros'))).macros).toHaveLength(0);
    for (const [method, suffix, payload] of [['PUT', '', body], ['DELETE', '', undefined], ['POST', '/use', {}]] as const) {
      expect((await request(1, 1, 'macros/' + macro.id + suffix, method, payload)).status).toBe(404);
    }
    expect((await request(2, 0, 'macros/' + macro.id, 'PUT', body)).status).toBe(403);
    expect((await request(2, 0, 'macros/' + macro.id + '/use', 'POST', {})).status).toBe(200);
    expect((await request(0, 0, 'macros/' + macro.id, 'PUT', { ...body, name: 'Updated' })).status).toBe(200);
    expect((await json(await request(0, 0, 'macros'))).macros[0]).toMatchObject({ name: 'Updated', usage_count: 1 });
    expect((await request(0, 0, 'macros/' + macro.id, 'DELETE')).status).toBe(200);
    expect((await json(await request(0, 0, 'macros'))).macros).toHaveLength(0);
    expect((await request(0, 0, 'macros/' + macro.id + '/use', 'POST', {})).status).toBe(404);
  });
});
