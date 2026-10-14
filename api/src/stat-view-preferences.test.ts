import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { StatViewPatch } from './routes/me.js';

test('statistic preferences accept only known IDs, supported formats and explicit fields', () => {
  expect(StatViewPatch.parse({ id: 'r-status', format: 'table' }).only_if_missing).toBe(false);
  for (const body of [null, {}, { id: '__proto__', format: 'table' }, { id: 'unknown', format: 'bar' },
    { id: 'r-csat', format: 'donut' }, { id: 'r-status', format: 'line' },
    { id: 'r-status', format: 'table', user_id: 'someone-else' },
    { id: 'r-status', format: 'table', workspace_id: 'elsewhere' },
    { id: 'r-status', format: 'table', only_if_missing: 'true' }]) {
    expect(StatViewPatch.safeParse(body).success).toBe(false);
  }
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('private statistic view preferences', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let workspace: string, other: string, user: string, teammate: string, token: string, otherToken: string;
  const suffix = crypto.randomUUID();
  const request = (body?: unknown, ws = workspace, credential = token) => app.request('/api/v1/me/stat-views', {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { Authorization: `Bearer ${credential}`, 'X-Workspace-Id': ws, 'Content-Type': 'application/json',
      'X-Forwarded-For': '2001:db8:910:' + suffix.slice(0, 4) + '::1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const a: any = await auth.api.signUpEmail({ body: { email: `stat-a-${suffix}@t.test`, password: 'password-12345', name: 'Preference A' } });
    const b: any = await auth.api.signUpEmail({ body: { email: `stat-b-${suffix}@t.test`, password: 'password-12345', name: 'Preference B' } });
    user = a.user.id; token = a.token; teammate = b.user.id; otherToken = b.token;
    [workspace, other] = await Promise.all(['a', 'b'].map(async key => {
      const [row] = await sql`select provision_brand('Preferences', ${'prefs-' + key + '-' + suffix}) id`;
      return row.id;
    }));
    for (const ws of [workspace, other]) {
      const [role] = await sql`select id from roles where workspace_id = ${ws} and not is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${ws},${user},${role.id})`;
      if (ws === workspace) await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${ws},${teammate},${role.id})`;
    }
  }, 30000);
  afterAll(async () => {
    for (const id of [workspace, other].filter(Boolean)) await sql`delete from workspaces where id=${id}`;
    for (const id of [user, teammate].filter(Boolean)) await sql`delete from users where id=${id}`;
  });
  test('requires authentication and active membership; no cache or owner override', async () => {
    expect((await request(undefined, workspace, 'invalid')).status).toBe(401);
    expect((await request(undefined, other, otherToken)).status).toBe(403);
    expect((await request({ id: 'r-status', format: 'table' }, other, otherToken)).status).toBe(403);
    expect((await request({ id: 'r-status', format: 'table', user_id: teammate })).status).toBe(400);
    const result = await request();
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.json()).toEqual({ views: {} });
  });
  test('member saves persist separately for each user and workspace', async () => {
    expect((await request({ id: 'r-status', format: 'table' })).status).toBe(200);
    expect(await (await request()).json()).toEqual({ views: { 'r-status': 'table' } });
    expect(await (await request(undefined, workspace, otherToken)).json()).toEqual({ views: {} });
    expect(await (await request(undefined, other)).json()).toEqual({ views: {} });
    await request({ id: 'r-status', format: 'donut' }, workspace, otherToken);
    expect(await (await request()).json()).toEqual({ views: { 'r-status': 'table' } });
  });
  test('concurrent statistic writes preserve unrelated keys and existing preferences', async () => {
    await sql`update user_preferences set theme='dark', dashboard_layout='{"hidden":[]}'::jsonb
      where workspace_id=${workspace} and user_id=${user}`;
    const responses = await Promise.all([
      request({ id: 'r-priority', format: 'donut' }), request({ id: 'dash-volume', format: 'line' }),
      request({ id: 'r-time', format: 'table' }),
    ]);
    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    const { views } = await (await request()).json() as any;
    expect(views).toMatchObject({ 'r-status': 'table', 'r-priority': 'donut', 'dash-volume': 'line', 'r-time': 'table' });
    const [row] = await sql`select theme,dashboard_layout from user_preferences where workspace_id=${workspace} and user_id=${user}`;
    expect(row).toMatchObject({ theme: 'dark', dashboard_layout: { hidden: [] } });
  });
  test('imports cannot overwrite an existing choice, including concurrent creation', async () => {
    const result = await request({ id: 'r-status', format: 'bar', only_if_missing: true });
    expect(await result.json()).toEqual({ format: 'table' });
    await Promise.all([
      request({ id: 'ai-trend', format: 'table', only_if_missing: true }),
      request({ id: 'ai-trend', format: 'line' }),
    ]);
    expect((await (await request()).json() as any).views['ai-trend']).toBe('line');
  });
});
