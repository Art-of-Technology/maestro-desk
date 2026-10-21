import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { TemplateFavouritePatch } from './routes/me.js';

test('template favourite writes accept only an explicit boolean, with no identity override', () => {
  expect(TemplateFavouritePatch.safeParse({ pinned: true }).success).toBe(true);
  expect(TemplateFavouritePatch.safeParse({ pinned: false }).success).toBe(true);
  for (const body of [null, {}, { pinned: 'true' }, { pinned: 1 }, { pinned: true, user_id: 'other' }, { pinned: true, workspace_id: 'other' }]) {
    expect(TemplateFavouritePatch.safeParse(body).success).toBe(false);
  }
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('private template favourites', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let workspace: string, other: string, user: string, teammate: string, token: string, otherToken: string;
  let first: string, second: string, foreign: string;
  const suffix = crypto.randomUUID();
  const request = (id?: string, body?: unknown, ws = workspace, credential = token) => app.request('/api/v1/me/template-favourites' + (id ? '/' + id : ''), {
    method: id ? 'PATCH' : 'GET',
    headers: { Authorization: `Bearer ${credential}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json',
      'X-Forwarded-For': '2001:db8:913:' + suffix.slice(0, 4) + '::1' },
    body: id ? JSON.stringify(body) : undefined,
  });
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb(); app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const a: any = await auth.api.signUpEmail({ body: { email: `favourite-a-${suffix}@t.test`, password: 'password-12345', name: 'Favourite A' } });
    const b: any = await auth.api.signUpEmail({ body: { email: `favourite-b-${suffix}@t.test`, password: 'password-12345', name: 'Favourite B' } });
    user = a.user.id; token = a.token; teammate = b.user.id; otherToken = b.token;
    [workspace, other] = await Promise.all(['a', 'b'].map(async key => {
      const [row] = await sql`select provision_brand('Favourites', ${'favourite-' + key + '-' + suffix}) id`;
      return row.id;
    }));
    for (const ws of [workspace, other]) {
      const [role] = await sql`select id from roles where workspace_id = ${ws} and not is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${ws},${user},${role.id})`;
      if (ws === workspace) await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${ws},${teammate},${role.id})`;
    }
    const ids = [];
    for (const [ws, name] of [[workspace, 'A'], [workspace, 'B'], [other, 'Other']]) {
      const [row] = await sql`insert into canned_responses(workspace_id,display_id,name,body) values(${ws},${'TPL-' + name},${name},'Example reply') returning id`;
      ids.push(row.id);
    }
    [first, second, foreign] = ids;
  }, 30000);
  afterAll(async () => {
    for (const id of [workspace, other].filter(Boolean)) await sql`delete from workspaces where id=${id}`;
    for (const id of [user, teammate].filter(Boolean)) await sql`delete from users where id=${id}`;
  });
  test('requires authentication, membership, valid IDs and exact writable fields', async () => {
    expect((await request(undefined, undefined, workspace, 'invalid')).status).toBe(401);
    expect((await request(undefined, undefined, other, otherToken)).status).toBe(403);
    expect((await request(first, { pinned: true }, other, otherToken)).status).toBe(403);
    expect((await request(first, { pinned: true, user_id: teammate })).status).toBe(400);
    expect((await request('invalid', { pinned: true })).status).toBe(400);
    expect((await request(first, { pinned: 'true' })).status).toBe(400);
    expect((await request(foreign, { pinned: true })).status).toBe(404);
    const result = await request();
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.json()).toEqual({ favourites: [] });
  });
  test('members pin privately per account and workspace, preserving other preferences', async () => {
    expect(await (await request(first, { pinned: true })).json()).toEqual({ template_id: first, pinned: true });
    expect(await (await request()).json()).toEqual({ favourites: [first] });
    expect(await (await request(undefined, undefined, workspace, otherToken)).json()).toEqual({ favourites: [] });
    expect(await (await request(undefined, undefined, other)).json()).toEqual({ favourites: [] });
    await sql`update user_preferences set theme='dark',stat_views='{"r-status":"table"}'::jsonb where workspace_id=${workspace} and user_id=${user}`;
    await Promise.all([request(first, { pinned: true }), request(second, { pinned: true })]);
    expect(await (await request()).json()).toEqual({ favourites: [first, second] });
    const [row] = await sql`select theme,stat_views from user_preferences where workspace_id=${workspace} and user_id=${user}`;
    expect(row).toMatchObject({ theme: 'dark', stat_views: { 'r-status': 'table' } });
  });
  test('unpinning is idempotent and deleted templates never appear as favourites', async () => {
    await request(first, { pinned: false }); await request(first, { pinned: false });
    expect(await (await request()).json()).toEqual({ favourites: [second] });
    await sql`delete from canned_responses where workspace_id=${workspace} and id=${second}`;
    expect(await (await request()).json()).toEqual({ favourites: [] });
    expect((await request(second, { pinned: true })).status).toBe(404);
    expect((await request(second, { pinned: false })).status).toBe(200);
    const [row] = await sql`select template_favourites from user_preferences where workspace_id=${workspace} and user_id=${user}`;
    expect(row.template_favourites).toEqual({});
    await sql`update workspace_members set active=false where workspace_id=${workspace} and user_id=${teammate}`;
    expect((await request(undefined, undefined, workspace, otherToken)).status).toBe(403);
    expect((await request(first, { pinned: true }, workspace, otherToken)).status).toBe(403);
  });
});
