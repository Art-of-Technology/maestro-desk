import { afterAll, describe, expect, it } from 'bun:test';

const dbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
dbTests('agent invitation registration', () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  afterAll(async () => {
    const sql = (await import('./lib/db.js')).getDb();
    if (workspaces.length) await sql`delete from workspaces where id in ${sql(workspaces)}`;
    if (users.length) await sql`delete from users where id in ${sql(users)}`;
  });

  it('keeps both invitation flows pending, activates on registration, and preserves disabled accounts', async () => {
    const { auth } = await import('./lib/auth.js');
    const { env } = await import('./lib/env.js');
    const sql = (await import('./lib/db.js')).getDb();
    const { agents } = await import('./routes/agents.js');
    const { god } = await import('./routes/god.js');
    const { whoami } = await import('./routes/whoami.js');
    const mailToken = env.POSTMARK_SERVER_TOKEN;
    env.POSTMARK_SERVER_TOKEN = ''; // Never send test invitations through Postmark.
    try {
      const admin = await auth.api.signUpEmail({ body: {
        email: `admin-${crypto.randomUUID()}@example.test`, name: 'Invitation admin', password: 'Admin-password-123!',
      }, returnHeaders: true });
      users.push(admin.response.user.id);
      await sql`update users set is_platform_admin = true where id = ${users[0]}`;
      const [{ id: workspace }] = await sql`select provision_brand(${`invite-${crypto.randomUUID()}`}, 'Invitation test') as id`;
      workspaces.push(workspace);
      const [role] = await sql`select id from roles where workspace_id = ${workspace} and name = 'Admin'`;
      const [{ id: otherWorkspace }] = await sql`select provision_brand(${`invite-other-${crypto.randomUUID()}`}, 'Other workspace') as id`;
      workspaces.push(otherWorkspace);
      const [otherRole] = await sql`select id from roles where workspace_id = ${otherWorkspace} and name = 'Admin'`;
      const headers = { Authorization: `Bearer ${admin.headers.get('set-auth-token')}`, 'X-Workspace-Id': workspace, 'Content-Type': 'application/json' };
      const patch = (id: string, active: boolean) => agents.request(`/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ active }) });
      const status = async (id: string) => (await sql`select active, invitation_pending from workspace_members where workspace_id = ${workspace} and user_id = ${id}`)[0];
      const reset = async (id: string) => {
        const token = crypto.randomUUID();
        await sql`insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
          values (${crypto.randomUUID()}, ${`reset-password:${token}`}, ${id}, now() + interval '1 hour', now(), now())`;
        await auth.api.resetPassword({ body: { token, newPassword: 'Registered-password-123!' } });
      };

      for (const owner of [false, true]) {
        const email = `invite-${crypto.randomUUID()}@example.test`;
        const invite = () => owner
          ? god.request(`/brands/${workspace}/invite`, { method: 'POST', headers, body: JSON.stringify({ email }) })
          : agents.request('/invite', { method: 'POST', headers, body: JSON.stringify({ email, role_id: role.id }) });
        const response = await invite();
        expect(response.status).toBe(201);
        const [user] = await sql`select id from users where email = ${email}`;
        users.push(user.id);
        await sql`insert into workspace_members (workspace_id, user_id, role_id, active)
          values (${otherWorkspace}, ${user.id}, ${otherRole.id}, false)`;
        expect(await status(user.id)).toEqual({ active: false, invitation_pending: true });
        expect((await patch(user.id, true)).status).toBe(409);
        await invite();
        expect(await status(user.id)).toEqual({ active: false, invitation_pending: true });
        await expect(auth.api.resetPassword({ body: { token: 'invalid', newPassword: 'Registered-password-123!' } })).rejects.toThrow();
        expect((await status(user.id)).active).toBe(false);
        const expiredToken = crypto.randomUUID();
        await sql`insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
          values (${crypto.randomUUID()}, ${`reset-password:${expiredToken}`}, ${user.id}, now() - interval '1 hour', now(), now())`;
        await expect(auth.api.resetPassword({ body: { token: expiredToken, newPassword: 'Registered-password-123!' } })).rejects.toThrow();
        expect((await status(user.id)).active).toBe(false);
        await reset(user.id);
        expect(await status(user.id)).toEqual({ active: true, invitation_pending: false });
        const [otherMember] = await sql`select active from workspace_members where workspace_id = ${otherWorkspace} and user_id = ${user.id}`;
        expect(otherMember.active).toBe(false);
        const login = await auth.api.signInEmail({ body: { email, password: 'Registered-password-123!' }, returnHeaders: true });
        const identity = await whoami.request('/', { headers: { Authorization: `Bearer ${login.headers.get('set-auth-token')}` } });
        const body = await identity.json() as { memberships: { workspace_id: string }[] };
        expect(body.memberships.map(m => m.workspace_id)).toContain(workspace);
        await invite();
        expect((await status(user.id)).active).toBe(true);
        expect((await patch(user.id, false)).status).toBe(200);
        await invite();
        await reset(user.id);
        expect(await status(user.id)).toEqual({ active: false, invitation_pending: false });
      }
    } finally { env.POSTMARK_SERVER_TOKEN = mailToken; }
  });
});
