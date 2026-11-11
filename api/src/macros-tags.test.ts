import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
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

  it('counts applied tags consistently across legacy types and preserves metadata on name-only edits', async () => {
    const suffix = crypto.randomUUID(), manual = 'manual-' + suffix, ai = 'ai-' + suffix;
    await request(0, 0, 'tags', 'POST', { tag: manual });
    await request(0, 0, 'tags', 'POST', { tag: ai, kind: 'ai', ai_confidence: 17 });
    const [customer] = await sql`insert into customers(workspace_id,display_id,first_name)
      values (${workspaces[0]},${'C-' + suffix},'Shared library test') returning id`;
    const tickets: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [ticket] = await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key)
        values (${workspaces[0]},${customer.id},${'T-' + i + suffix},'Shared library test','open','normal') returning id`;
      tickets.push(ticket.id);
      await sql`insert into ticket_ai_tags(workspace_id,ticket_id,tag,confidence,accepted)
        values (${workspaces[0]},${ticket.id},${ai},90,${i === 1})`;
    }
    await sql`insert into ticket_tags(workspace_id,ticket_id,tag) values
      (${workspaces[0]},${tickets[0]},${manual}), (${workspaces[0]},${tickets[1]},${ai})`;
    const counts = async () => (await json(await request(0, 0, 'tags'))).tags;
    expect(await counts()).toContainEqual({ tag: manual, kind: 'manual', ai_confidence: null, count: 1 });
    expect(await counts()).toContainEqual({ tag: ai, kind: 'ai', ai_confidence: 17, count: 1 });
    expect((await request(0, 0, `tickets/${tickets[0]}/ai_tags/${ai}`, 'PATCH', { accepted: true })).status).toBe(200);
    expect(await counts()).toContainEqual({ tag: ai, kind: 'ai', ai_confidence: 17, count: 2 });
    const renamed = ai + '-new';
    expect((await json(await request(0, 0, `tags/${ai}`, 'PATCH', { tag: renamed }))).tag)
      .toEqual({ tag: renamed, kind: 'ai', ai_confidence: 17 });
    const merged = await json(await request(0, 0, `tags/${manual}/merge`, 'POST', { into: renamed }));
    expect(merged.target_count).toBe(2);
    expect((await request(0, 0, `tags/merges/${merged.merge_id}/undo`, 'POST')).status).toBe(200);
    expect(await counts()).toContainEqual({ tag: renamed, kind: 'ai', ai_confidence: 17, count: 2 });
    expect(await counts()).toContainEqual({ tag: manual, kind: 'manual', ai_confidence: null, count: 1 });
  });

  async function mergeFixture() {
    const suffix = crypto.randomUUID();
    const source = 'source-' + suffix, target = 'target-' + suffix;
    await request(0, 0, 'tags', 'POST', { tag: source, kind: 'ai', ai_confidence: 72 });
    await request(0, 0, 'tags', 'POST', { tag: target });
    const [customer] = await sql`insert into customers(workspace_id,display_id,first_name)
      values (${workspaces[0]},${'C-' + suffix},'Merge test') returning id`;
    const tickets = [];
    for (let i = 0; i < 3; i++) {
      const [ticket] = await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key)
        values (${workspaces[0]},${customer.id},${'T-' + i + suffix},'Merge test','open','normal') returning id`;
      tickets.push(ticket.id);
    }
    for (const ticket of tickets.slice(0, 2)) {
      await sql`insert into ticket_tags(workspace_id,ticket_id,tag) values (${workspaces[0]},${ticket},${source})`;
      await sql`insert into ticket_ai_tags(workspace_id,ticket_id,tag,confidence,accepted)
        values (${workspaces[0]},${ticket},${source},72,true)`;
    }
    await sql`insert into ticket_tags(workspace_id,ticket_id,tag) values (${workspaces[0]},${tickets[1]},${target})`;
    await sql`insert into ticket_ai_tags(workspace_id,ticket_id,tag,confidence,accepted)
      values (${workspaces[0]},${tickets[1]},${target},91,false)`;
    const response = await request(0, 0, `tags/${source}/merge`, 'POST', { into: target });
    expect(response.status).toBe(200);
    return { source, target, tickets, id: (await json(response)).merge_id };
  }

  it('undo restores manual and AI assignments, preserves overlaps and later unrelated assignments', async () => {
    const { source, target, tickets, id } = await mergeFixture();
    await sql`insert into ticket_tags(workspace_id,ticket_id,tag) values (${workspaces[0]},${tickets[2]},${target})`;
    expect((await request(2, 0, 'tags/merges')).status).toBe(403);
    expect((await request(2, 0, `tags/merges/${id}/undo`, 'POST')).status).toBe(403);
    expect((await request(1, 1, `tags/merges/${id}/undo`, 'POST')).status).toBe(404);
    expect((await json(await request(1, 1, 'tags/merges'))).merges).toHaveLength(0);
    expect((await json(await request(0, 0, 'tags/merges'))).merges).toContainEqual(expect.objectContaining({ id, source, target }));
    expect((await request(0, 0, `tags/merges/${id}/undo`, 'POST')).status).toBe(200);
    const library = await sql`select kind,ai_confidence from tag_library where workspace_id=${workspaces[0]} and tag=${source}`;
    expect(library[0]).toEqual({ kind: 'ai', ai_confidence: 72 });
    expect((await sql`select tag from ticket_tags where ticket_id=${tickets[0]}`).map(r => r.tag)).toEqual([source]);
    expect((await sql`select tag from ticket_tags where ticket_id=${tickets[1]}`).map(r => r.tag).sort()).toEqual([source, target].sort());
    expect((await sql`select tag from ticket_tags where ticket_id=${tickets[2]}`).map(r => r.tag)).toEqual([target]);
    const ai = await sql`select tag,confidence,accepted from ticket_ai_tags where ticket_id=${tickets[1]} order by tag`;
    expect([...ai]).toEqual([{ tag: source, confidence: 72, accepted: true }, { tag: target, confidence: 91, accepted: false }]);
    expect((await request(0, 0, `tags/merges/${id}/undo`, 'POST')).status).toBe(409);
    expect((await json(await request(0, 0, 'tags/merges'))).merges.find((m: any) => m.id === id).undone_at).toBeTruthy();
  });

  it('blocks undo after affected assignments or tags change without partially restoring anything', async () => {
    for (const change of ['readd', 'ai-edit', 'rename', 'recreate-source', 'delete-ticket', 'merge-again', 'merge-into-target']) {
      const { source, target, tickets, id } = await mergeFixture();
      if (change === 'readd') {
        await sql`delete from ticket_tags where ticket_id=${tickets[0]} and tag=${target}`;
        await sql`insert into ticket_tags(workspace_id,ticket_id,tag) values (${workspaces[0]},${tickets[0]},${target})`;
      } else if (change === 'ai-edit') {
        await sql`update ticket_ai_tags set accepted=true where ticket_id=${tickets[1]} and tag=${target}`;
      } else if (change === 'rename') {
        expect((await request(0, 0, `tags/${target}`, 'PATCH', { tag: target + '-new' })).status).toBe(200);
      } else if (change === 'recreate-source') {
        expect((await request(0, 0, 'tags', 'POST', { tag: source })).status).toBe(201);
      } else if (change === 'delete-ticket') {
        await sql`delete from tickets where id=${tickets[0]}`;
      } else if (change === 'merge-again') {
        await request(0, 0, 'tags', 'POST', { tag: target + '-new' });
        expect((await request(0, 0, `tags/${target}/merge`, 'POST', { into: target + '-new' })).status).toBe(200);
      } else {
        await request(0, 0, 'tags', 'POST', { tag: target + '-new' });
        expect((await request(0, 0, `tags/${target}-new/merge`, 'POST', { into: target })).status).toBe(200);
      }
      expect((await request(0, 0, `tags/merges/${id}/undo`, 'POST')).status).toBe(409);
      expect(await sql`select tag from ticket_tags where workspace_id=${workspaces[0]} and tag=${source}`).toHaveLength(0);
      expect((await sql`select undone_at from tag_merges where id=${id}`)[0].undone_at).toBeNull();
    }
  });

  it('rolls back every undo change if restoring an assignment fails', async () => {
    const { source, target, tickets, id } = await mergeFixture();
    await sql.unsafe(`alter table ticket_ai_tags add constraint tag_undo_test_failure check (tag <> '${source}') not valid`);
    try {
      expect((await request(0, 0, `tags/merges/${id}/undo`, 'POST')).status).toBe(500);
      expect(await sql`select tag from tag_library where workspace_id=${workspaces[0]} and tag=${source}`).toHaveLength(0);
      expect((await sql`select tag from ticket_tags where ticket_id=${tickets[0]}`).map(r => r.tag)).toEqual([target]);
      expect((await sql`select undone_at from tag_merges where id=${id}`)[0].undone_at).toBeNull();
    } finally { await sql`alter table ticket_ai_tags drop constraint tag_undo_test_failure`; }
    expect((await request(0, 0, `tags/merges/${id}/undo`, 'POST')).status).toBe(200);
  });

  it('validates merge inputs and safely serializes duplicate undo requests', async () => {
    const { source, target, id } = await mergeFixture();
    expect((await request(0, 0, `tags/${source}/merge`, 'POST', { into: target })).status).toBe(404);
    expect((await request(0, 0, `tags/${target}/merge`, 'POST', { into: target })).status).toBe(400);
    expect((await request(0, 0, 'tags/merges/invalid/undo', 'POST')).status).toBe(400);
    const results = await Promise.all([request(0, 0, `tags/merges/${id}/undo`, 'POST'), request(0, 0, `tags/merges/${id}/undo`, 'POST')]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  });

  it('rejects unapproved tags and restricts AI suggestions to the workspace library', async () => {
    const [customer] = await sql`insert into customers(workspace_id,display_id,first_name) values (${workspaces[0]},'M-TAG','Test') returning id`;
    const [ticket] = await sql`insert into tickets(workspace_id,customer_id,display_id,subject,status_key,priority_key) values (${workspaces[0]},${customer.id},'TK-TAG','Test tags','open','normal') returning id`;
    const path = 'tickets/' + ticket.id;
    expect((await request(0, 0, path + '/tags', 'POST', { tag: 'invented' })).status).toBe(400);
    expect((await request(1, 1, 'tags', 'POST', { tag: 'foreign' })).status).toBe(201);
    expect((await request(0, 0, path + '/tags', 'POST', { tag: 'foreign' })).status).toBe(400);
    await sql`insert into ticket_ai_tags(workspace_id,ticket_id,tag,confidence) values (${workspaces[0]},${ticket.id},'invented',90)`;
    expect((await request(0, 0, path + '/ai_tags/invented', 'PATCH', { accepted: true })).status).toBe(400);
    expect(await sql`select tag from ticket_tags where ticket_id=${ticket.id}`).toHaveLength(0);
    expect((await request(0, 0, 'tags', 'POST', { tag: 'approved' })).status).toBe(201);
    expect((await request(0, 0, path + '/tags', 'POST', { tag: 'approved' })).status).toBe(201);
    expect((await request(0, 0, 'macros', 'POST', { name: 'Invalid', actions: [{ kind: 'tag', value: 'invented' }] })).status).toBe(400);
    const { anthropic } = await import('./lib/anthropic.js');
    await sql`update workspaces set ai_credits_micro=1000000 where id=${workspaces[0]}`;
    const create = spyOn(anthropic.messages, 'create').mockResolvedValue({ id: 'tags', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: '["foreign","approved","approved","invented"]' }] } as any);
    try {
      const response = await request(0, 0, 'ai/messages', 'POST', { action: 'tag_suggestions', messages: [{ role: 'user', content: 'Draft email about approved' }] });
      expect(response.status).toBe(200);
      expect(JSON.parse((await json(response)).text)).toEqual(['approved']);
      expect((create.mock.calls[0][0] as any).system).toContain('approved');
      expect((create.mock.calls[0][0] as any).system).not.toContain('foreign');
    } finally { create.mockRestore(); }
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
