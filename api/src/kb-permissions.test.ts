import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('knowledge article permissions', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const users: { id: string; token: string }[] = [];
  const workspaces: string[] = [];
  let adminRole: string, memberRole: string;
  const content = { title: 'Withdrawal policy', category: 'Help', body: 'Reviewed content' };

  function request(method: string, path = '', body?: object, user = 0, workspace = 0) {
    return app.request('/api/v1/kb-articles' + path, {
      method,
      headers: { Authorization: `Bearer ${users[user].token}`, 'X-Workspace-Id': workspaces[workspace], 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function create(status = 'draft', user = 0) {
    const response = await request('POST', '', { ...content, status }, user);
    expect(response.status).toBe(201);
    return (await response.json() as { article: { id: string; status: string } }).article;
  }
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const run = crypto.randomUUID();
    for (let i = 0; i < 3; i++) {
      const signed = await auth.api.signUpEmail({ body: {
        email: `kb-permissions-${run}-${i}@t.test`, password: 'test-password-12345', name: 'KB permissions test',
      } });
      users.push({ id: signed.user.id, token: signed.token! });
    }
    for (let i = 0; i < 2; i++) {
      const [row] = await sql`select provision_brand('KB permissions', ${'kb-permissions-' + run + '-' + i}) as id`;
      workspaces.push(row.id);
      const [admin] = await sql`select id from roles where workspace_id=${row.id} and is_admin=true limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${row.id},${users[0].id},${admin.id},true)`;
      if (i === 0) adminRole = admin.id;
    }
    const [member] = await sql`select id from roles where workspace_id=${workspaces[0]} and is_admin=false limit 1`;
    memberRole = member.id;
    await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values(${workspaces[0]},${users[1].id},${memberRole},true)`;
    await sql`update users set is_platform_admin=true where id=${users[2].id}`;
  }, 30000);
  afterAll(async () => {
    if (!sql) return;
    for (const id of workspaces) await sql`delete from workspaces where id=${id}`;
    for (const user of users) await sql`delete from users where id=${user.id}`;
  });

  it('rejects member creation, status changes, live edits and deletion without changing data', async () => {
    const draft = await create(), published = await create('published');
    const before = await sql`select id,title,body,status from kb_articles where workspace_id=${workspaces[0]} order by id`;
    for (const payload of [content, { ...content, status: 'draft' }, { ...content, status: 'published' }]) {
      const response = await request('POST', '', payload, 1);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Admin permission required' });
    }
    for (const article of [draft, published]) {
      for (const payload of [{ status: 'published' }, { status: 'archived' }, { status: 'draft' }, { body: 'Bypass' }, { title: 'Bypass', category: 'Changed' }]) {
        expect((await request('PATCH', '/' + article.id, payload, 1)).status).toBe(403);
      }
      expect((await request('DELETE', '/' + article.id, undefined, 1)).status).toBe(403);
    }
    const after = await sql`select id,title,body,status from kb_articles where workspace_id=${workspaces[0]} order by id`;
    expect(after).toEqual(before);
  });

  it('allows admin lifecycle operations, including the PATCH requests used by bulk publishing', async () => {
    for (const user of [0, 2]) {
      const drafts = [await create('draft', user), await create('draft', user)];
      for (const article of drafts) {
        const response = await request('PATCH', '/' + article.id, { status: 'published' }, user);
        expect(response.status).toBe(200);
        expect((await response.json() as { article: { status: string } }).article.status).toBe('published');
      }
      const id = drafts[0].id;
      expect((await request('PATCH', '/' + id, { body: 'Admin edit', status: 'archived' }, user)).status).toBe(200);
      expect((await request('DELETE', '/' + id, undefined, user)).status).toBe(204);
      expect(await sql`select id from kb_articles where id=${id}`).toHaveLength(0);
    }
  });

  it('rechecks roles between requests and rejects inactive members and revoked platform admins', async () => {
    const first = await create(), second = await create();
    try {
      expect((await request('PATCH', '/' + first.id, { status: 'published' })).status).toBe(200);
      await sql`update workspace_members set role_id=${memberRole} where workspace_id=${workspaces[0]} and user_id=${users[0].id}`;
      expect((await request('PATCH', '/' + second.id, { status: 'published' })).status).toBe(403);
      await sql`update workspace_members set role_id=${adminRole},active=false where workspace_id=${workspaces[0]} and user_id=${users[0].id}`;
      expect((await request('PATCH', '/' + second.id, { status: 'published' })).status).toBe(403);
      await sql`update users set is_platform_admin=false where id=${users[2].id}`;
      expect((await request('PATCH', '/' + second.id, { status: 'published' }, 2)).status).toBe(403);
      const [row] = await sql`select status from kb_articles where id=${second.id}`;
      expect(row.status).toBe('draft');
    } finally {
      await sql`update workspace_members set role_id=${adminRole},active=true where workspace_id=${workspaces[0]} and user_id=${users[0].id}`;
      await sql`update users set is_platform_admin=true where id=${users[2].id}`;
    }
  });

  it('preserves workspace isolation even for an admin of both workspaces', async () => {
    const article = await create();
    expect((await request('PATCH', '/' + article.id, { status: 'published' }, 0, 1)).status).toBe(404);
    expect((await request('DELETE', '/' + article.id, undefined, 0, 1)).status).toBe(204);
    const [row] = await sql`select status from kb_articles where id=${article.id}`;
    expect(row.status).toBe('draft');
    const response = await request('GET', '', undefined, 0, 1);
    expect((await response.json() as { articles: { id: string }[] }).articles.some(a => a.id === article.id)).toBe(false);
    expect((await request('PATCH', '/' + article.id, { status: 'published' }, 1, 1)).status).toBe(403);
  });

  it('updates timestamps only for content or status changes, not views, votes or no-op saves', async () => {
    const article = await create();
    const stamp = async () => (await sql`select updated_at::text as stamp from kb_articles where id=${article.id}`)[0].stamp;
    const original = await stamp();
    await request('POST', '/' + article.id + '/view', undefined, 1);
    await request('POST', '/' + article.id + '/vote', { direction: 'up' }, 1);
    await request('PATCH', '/' + article.id, { body: content.body });
    expect(await stamp()).toBe(original);
    await request('PATCH', '/' + article.id, { body: 'Edited content' });
    const edited = await stamp();
    expect(edited).not.toBe(original);
    await request('PATCH', '/' + article.id, { status: 'published' });
    expect(await stamp()).not.toBe(edited);
  });

  it('retrieves a bounded set of matching published entries with full game URLs', async () => {
    const { suggestedKnowledgeArticles } = await import('./lib/knowledge-context.js');
    const link = 'https://www.spacecasino.com/en-ca/games/netent/quasarfixture-special/123';
    const rows = Array.from({ length: 150 }, (_, i) => ({ workspace_id: workspaces[0], display_id: 'SEARCH-' + i,
      title: i === 0 ? '[en-ca] quasarfixture special' : i < 30 ? `quasarfixture ${i}` : `Unrelated ${i}`,
      body: i === 0 ? link : 'Unrelated information. '.repeat(40), category: 'Games · en-ca', status: 'published' }));
    await sql`insert into kb_articles ${sql(rows)}`;
    await sql`insert into kb_articles (workspace_id,display_id,title,body,status) values
      (${workspaces[0]},'SEARCH-DRAFT','quasarfixture special','Draft secret','draft'),
      (${workspaces[1]},'SEARCH-OTHER','quasarfixture special','Other workspace secret','published')`;
    const result = await suggestedKnowledgeArticles(workspaces[0], 'quasarfixture special');
    expect(result).toHaveLength(12);
    expect(result[0].body).toBe(link);
    expect(result.some(a => a.display_id === 'SEARCH-DRAFT' || a.display_id === 'SEARCH-OTHER')).toBe(false);
    expect(result.every(a => a.title.includes('quasarfixture') && a.body.length <= 600)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(rows).length / 5);
    expect(await suggestedKnowledgeArticles(workspaces[0], 'zzznomatchingterm')).toHaveLength(0);
    expect(await suggestedKnowledgeArticles(workspaces[0], '!?')).toHaveLength(0);
  });

  it('keeps reading, viewing and helpfulness voting available to members', async () => {
    const article = await create('published');
    expect((await request('GET', '', undefined, 1)).status).toBe(200);
    expect((await request('POST', '/' + article.id + '/view', undefined, 1)).status).toBe(200);
    const vote = await request('POST', '/' + article.id + '/vote', { direction: 'up' }, 1);
    expect(vote.status).toBe(200);
    expect((await vote.json() as { my_vote: number }).my_vote).toBe(1);
    expect((await request('POST', '/' + article.id + '/vote', { direction: 'clear' }, 1)).status).toBe(200);
  });
});
