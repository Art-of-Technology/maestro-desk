import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { SPACE_CASINO_WORKSPACE as ws } from './lib/knowledge-market-policy.js';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

(process.env.RUN_DB_TESTS ? describe : describe.skip)('Space Casino market import boundaries', () => {
  let app: typeof import('./index.js').default, sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let token: string, user: string, other: string, created = false;
  const request = (path: string, method = 'GET', body?: unknown, workspace = ws) => app.request('/api/v1/'+path, {
    method, headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspace, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    // Never mutate an existing production-identity workspace in a reused test DB.
    if ((await sql`select id from workspaces where id=${ws}`).length) throw Error('Use an isolated empty test database for market-policy tests');
    const { auth } = await import('./lib/auth.js');
    const run = crypto.randomUUID();
    const signed = await auth.api.signUpEmail({ body: { email: `market-${run}@t.test`, password: 'test-password-12345', name: 'Market test' } });
    user = signed.user.id; token = signed.token!;
    await sql`insert into workspaces(id,slug,name) values (${ws},${'market-'+run},'Space Casino fixture')`;
    created = true;
    await sql`select seed_default_roles(${ws})`;
    const [otherRow] = await sql`select provision_brand(${'other-'+run},${'other-'+run}) as id`;
    other = otherRow.id;
    for (const id of [ws,other]) {
      const [role] = await sql`select id from roles where workspace_id=${id} and is_admin=true limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id,active) values (${id},${user},${role.id},true)`;
    }
  });
  afterAll(async () => {
    if (created) await sql`delete from workspaces where id=${ws}`;
    if (other) await sql`delete from workspaces where id=${other}`;
    if (user) await sql`delete from users where id=${user}`;
  });

  it('blocks source imports and bulk article creation but preserves other workspaces and markets', async () => {
    const importModule = await import('./lib/knowledge-import.js');
    const fetch = spyOn(importModule, 'fetchKnowledgePage');
    try {
      for (const input of [
        { title:'Help', category:'Website', language:'en', jurisdiction:'',url:'https://www.spacecasino.com/pt-br/help' },
        { title:'Help', category:'Website', language:'es', jurisdiction:'Perú',url:'https://example.com/help' },
      ]) {
        const res = await request('knowledge-sources','POST',input);
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('no longer supported');
      }
      expect(fetch).toHaveBeenCalledTimes(0);
    } finally { fetch.mockRestore(); }
    const game = { title:'Game',category:'Games',body:'https://www.spacecasino.com/es-pe/games/provider/game/1' };
    expect((await request('kb-articles','POST',game)).status).toBe(400);
    expect((await request('kb-articles','POST',game,other)).status).toBe(201);
    const supported = await request('kb-articles','POST',{...game,body:'https://www.spacecasino.com/es-mx/games/provider/game/1'});
    expect(supported.status).toBe(201);
    const { article } = await supported.json() as any;
    expect((await request('kb-articles/'+article.id,'PATCH',{category:'Games · pt-br'})).status).toBe(400);
    const [row] = await sql`select category from kb_articles where id=${article.id}`;
    expect(row.category).toBe('Games');
  });

  it('blocks legacy refreshes, disables scheduled retries and rejects publishing stored excluded versions', async () => {
    const [source] = await sql`insert into knowledge_sources(workspace_id,kind,title,category,language,jurisdiction,locator,fingerprint,auto_refresh)
      values (${ws},'url','Retired source','Website','es','', 'https://www.spacecasino.com/es-pe/help','excluded-test',true) returning id`;
    const importModule = await import('./lib/knowledge-import.js');
    const fetch = spyOn(importModule,'fetchKnowledgePage');
    try {
      const { refreshKnowledgeSource, saveKnowledgeVersion } = await import('./lib/knowledge-sources.js');
      let failure: unknown;
      try { await refreshKnowledgeSource(ws,source.id,true); } catch (error) { failure = error; }
      expect(String(failure)).toContain('no longer supported');
      expect(fetch).toHaveBeenCalledTimes(0);
      const [state] = await sql`select auto_refresh,error,lease_until from knowledge_sources where id=${source.id}`;
      expect(state.auto_refresh).toBe(false);
      expect(state.error).toContain('no longer supported');
      expect(state.lease_until).toBeNull();
      expect((await request('knowledge-sources/'+source.id,'PATCH',{auto_refresh:true})).status).toBe(400);
      failure = undefined;
      try { await saveKnowledgeVersion(ws,source.id,{body:'Help',warnings:[]}); } catch (error) { failure = error; }
      expect(String(failure)).toContain('no longer supported');
    } finally { fetch.mockRestore(); }
    // A legacy version must not bypass checks by being approved after removal.
    const [version] = await sql`insert into knowledge_source_versions(workspace_id,source_id,content_hash,body,warnings)
      values (${ws},${source.id},'legacy','Help','[]'::jsonb) returning id`;
    expect((await request('knowledge-sources/'+source.id+'/publish','POST',{version_id:version.id})).status).toBe(400);
    const [state] = await sql`select article_id,approved_version_id from knowledge_sources where id=${source.id}`;
    expect(state.article_id).toBeNull();
    expect(state.approved_version_id).toBeNull();
  });
});
