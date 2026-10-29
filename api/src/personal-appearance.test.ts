import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { MePatch } from './routes/me.js';

test('appearance accepts only supported choices and rejects owner overrides', () => {
  for (const display_mode of ['light', 'dark', 'system'] as const) expect(MePatch.parse({ display_mode })).toEqual({ display_mode });
  expect(MePatch.safeParse({ display_mode: 'blue' }).success).toBe(false);
  expect(MePatch.parse({ navigation_position: 'top', colour_scheme: 'teal' })).toEqual({ navigation_position: 'top', colour_scheme: 'teal' });
  for (const body of [null, { colour_scheme: 'dark' }, { navigation_position: 'bottom' },
    { colour_scheme: '#ff0000' }, { colour_scheme: 'blue', user_id: 'other' }, { navigation_position: true }]) {
    expect(MePatch.safeParse(body).success).toBe(false);
  }
});

(process.env.RUN_DB_TESTS ? describe : describe.skip)('personal account appearance', () => {
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let app: typeof import('./index.js').default;
  let user: string, teammate: string, token: string, otherToken: string;
  const workspaces: string[] = [];
  const suffix = crypto.randomUUID();
  const request = (body?: unknown, workspace = workspaces[0], credential = token) => app.request('/api/v1/me', {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { Authorization: `Bearer ${credential}`, 'X-Workspace-Id': workspace, 'Content-Type': 'application/json',
      'X-Forwarded-For': '2001:db8:914:' + suffix.slice(0, 4) + '::1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const a: any = await auth.api.signUpEmail({ body: { email: `appearance-a-${suffix}@t.test`, password: 'password-12345', name: 'Appearance A' } });
    const b: any = await auth.api.signUpEmail({ body: { email: `appearance-b-${suffix}@t.test`, password: 'password-12345', name: 'Appearance B' } });
    user = a.user.id; token = a.token; teammate = b.user.id; otherToken = b.token;
    for (const key of ['a', 'b']) {
      const [row] = await sql`select provision_brand('Appearance', ${'appearance-' + key + '-' + suffix}) id`;
      workspaces.push(row.id);
      const [role] = await sql`select id from roles where workspace_id = ${row.id} and not is_admin limit 1`;
      await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${row.id},${user},${role.id})`;
      if (key === 'a') await sql`insert into workspace_members(workspace_id,user_id,role_id) values (${row.id},${teammate},${role.id})`;
    }
  }, 30000);
  afterAll(async () => {
    for (const id of workspaces) await sql`delete from workspaces where id=${id}`;
    for (const id of [user, teammate].filter(Boolean)) await sql`delete from users where id=${id}`;
  });
  test('defaults are returned privately and only a verified member may update their own preferences', async () => {
    const response = await request();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json() as any).user).toMatchObject({ navigation_position: 'left', colour_scheme: 'violet' });
    expect((await request(undefined, workspaces[0], 'invalid')).status).toBe(401);
    expect((await request({ colour_scheme: 'blue' }, workspaces[1], otherToken)).status).toBe(403);
    expect((await request({ colour_scheme: 'blue', user_id: teammate })).status).toBe(400);
    expect((await request({})).status).toBe(400);
  });
  test('choices follow the account across workspaces without changing teammates or workspace branding', async () => {
    const [brand] = await sql`select primary_color from workspaces where id=${workspaces[0]}`;
    expect((await request({ navigation_position: 'top', colour_scheme: 'teal', display_mode: 'dark' })).status).toBe(200);
    expect((await (await request(undefined, workspaces[1])).json() as any).user).toMatchObject({ navigation_position: 'top', colour_scheme: 'teal', display_mode: 'dark' });
    expect((await (await request(undefined, workspaces[0], otherToken)).json() as any).user).toMatchObject({ navigation_position: 'left', colour_scheme: 'violet' });
    expect((await sql`select primary_color from workspaces where id=${workspaces[0]}`)[0]).toEqual(brand);
    await request({ mention_email_enabled: false });
    expect((await (await request()).json() as any).user).toMatchObject({ navigation_position: 'top', colour_scheme: 'teal', mention_email_enabled: false });
    await request({ navigation_position: 'left', colour_scheme: 'violet' });
    expect((await (await request()).json() as any).user).toMatchObject({ navigation_position: 'left', colour_scheme: 'violet' });
  });
});
