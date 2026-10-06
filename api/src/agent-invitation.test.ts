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

  it('requires mailbox proof for a previously claimed address and revokes old sessions', async () => {
    const { auth } = await import('./lib/auth.js');
    const { env } = await import('./lib/env.js');
    const app = (await import('./index.js')).default;
    const sql = (await import('./lib/db.js')).getDb();
    const oldToken = env.POSTMARK_SERVER_TOKEN;
    env.POSTMARK_SERVER_TOKEN = '';
    try {
      const admin = await auth.api.signUpEmail({ body: { email: `proof-admin-${crypto.randomUUID()}@example.test`, name: 'Admin', password: 'Admin-password-123!' } });
      users.push(admin.user.id);
      await sql`update users set is_platform_admin=true where id=${admin.user.id}`;
      const [{ id: workspace }] = await sql`select provision_brand(${`proof-${crypto.randomUUID()}`}, 'Mailbox proof') as id`;
      workspaces.push(workspace);
      const [role] = await sql`select id from roles where workspace_id=${workspace} and is_admin`;
      for (const owner of [false, true]) {
        // Represents an account claimed before public signup was closed.
        const email = `claimed-${crypto.randomUUID()}@example.test`;
        const claimed = await auth.api.signUpEmail({ body: { email, name: 'Claimed', password: 'Attacker-password-123!' } });
        users.push(claimed.user.id);
        const invite = await app.request(owner ? `/api/v1/god/brands/${workspace}/invite` : '/api/v1/agents/invite', {
          method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'X-Workspace-Id': workspace, 'Content-Type': 'application/json' },
          body: JSON.stringify(owner ? { email } : { email, role_id: role.id }),
        });
        expect(invite.status).toBe(201);
        expect((await invite.json() as any).email_sent).toBe(false);
        const signed = await auth.api.signInEmail({ body: { email, password: 'Attacker-password-123!' } });
        const oldHeaders = new Headers({ Authorization: `Bearer ${signed.token}`, 'X-Workspace-Id': workspace });
        expect((await app.request('/api/v1/tickets', { headers: oldHeaders })).status).toBe(403);
        const proof = crypto.randomUUID();
        await sql`insert into verification (id,identifier,value,"expiresAt","createdAt","updatedAt")
          values (${crypto.randomUUID()},${'reset-password:' + proof},${claimed.user.id},now()+interval '1 hour',now(),now())`;
        await auth.api.resetPassword({ body: { token: proof, newPassword: 'Owner-password-123!' } });
        expect(await auth.api.getSession({ headers: oldHeaders })).toBeNull();
        expect(await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${claimed.token}` }) })).toBeNull();
        const oldLogin = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'Attacker-password-123!' }) });
        expect(oldLogin.status).toBe(401);
        await expect(auth.api.resetPassword({ body: { token: proof, newPassword: 'Replay-password-123!' } })).rejects.toThrow();
        const ownerSession = await auth.api.signInEmail({ body: { email, password: 'Owner-password-123!' } });
        expect(ownerSession.user.emailVerified).toBe(true);
        expect((await app.request('/api/v1/tickets', { headers: { Authorization: `Bearer ${ownerSession.token}`, 'X-Workspace-Id': workspace } })).status).toBe(200);
      }
    } finally { env.POSTMARK_SERVER_TOKEN = oldToken; }
  });

  it('blocks public password signup but keeps server-side invitations available', async () => {
    const app = (await import('./index.js')).default;
    const email = `public-${crypto.randomUUID()}@example.test`;
    const result = await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: 'Uninvited', password: 'Public-password-123!' }) });
    expect(result.status).toBe(403);
    const sql = (await import('./lib/db.js')).getDb();
    expect(await sql`select id from users where email=${email}`).toHaveLength(0);
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
      await sql`update users set is_platform_admin = true where id = ${admin.response.user.id}`;
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
        if (owner) {
          const result = await response.json() as any;
          expect(result.email_sent).toBe(false);
          expect(new URL(result.invite_link).hash).toBe(`#/w/${workspace}/dashboard`);
          expect(result.invite_link).not.toContain('reset_token');
        }
        const [user] = await sql`select id from users where email = ${email}`;
        users.push(user.id);
        await sql`insert into workspace_members (workspace_id, user_id, role_id, active)
          values (${otherWorkspace}, ${user.id}, ${otherRole.id}, false)`;
        expect(await status(user.id)).toEqual({ active: false, invitation_pending: true });
        await expect(auth.api.signInEmail({ body: { email, password: 'Wrong-password-123!' } })).rejects.toThrow();
        expect((await status(user.id)).active).toBe(false);
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
        // A registered user joins another workspace by signing in, without a reset.
        await sql`delete from workspace_members where workspace_id = ${otherWorkspace} and user_id = ${user.id}`;
        const secondHeaders = { ...headers, 'X-Workspace-Id': otherWorkspace };
        const secondInvite = owner
          ? await god.request(`/brands/${otherWorkspace}/invite`, { method: 'POST', headers, body: JSON.stringify({ email }) })
          : await agents.request('/invite', { method: 'POST', headers: secondHeaders, body: JSON.stringify({ email, role_id: otherRole.id }) });
        expect(secondInvite.status).toBe(201);
        await auth.api.signInEmail({ body: { email, password: 'Registered-password-123!' } });
        const [joined] = await sql`select active, invitation_pending from workspace_members where workspace_id = ${otherWorkspace} and user_id = ${user.id}`;
        expect(joined).toEqual({ active: true, invitation_pending: false });
        expect(await status(user.id)).toEqual({ active: false, invitation_pending: false });
      }
    } finally { env.POSTMARK_SERVER_TOKEN = mailToken; }
  });
  it('returns a safe share link for new and existing owners, including failed delivery', async () => {
    const { auth } = await import('./lib/auth.js');
    const { env } = await import('./lib/env.js');
    const { god } = await import('./routes/god.js');
    const sql = (await import('./lib/db.js')).getDb();
    const oldFetch = globalThis.fetch;
    const oldToken = env.POSTMARK_SERVER_TOKEN;
    const oldFrom = env.POSTMARK_OUTBOUND_FROM;
    const mail: any[] = [];
    let fail = false;
    globalThis.fetch = (async (_url: any, init: any) => {
      mail.push(JSON.parse(init.body));
      return fail ? new Response('Mail unavailable', { status: 503 })
        : Response.json({ ErrorCode: 0, MessageID: crypto.randomUUID(), SubmittedAt: new Date().toISOString() });
    }) as typeof fetch;
    env.POSTMARK_SERVER_TOKEN = 'local-test-only';
    env.POSTMARK_OUTBOUND_FROM = 'support@example.test';
    try {
      const admin = await auth.api.signUpEmail({ body: { email: `admin-${crypto.randomUUID()}@example.test`, name: 'Admin', password: 'Admin-password-123!' }, returnHeaders: true });
      users.push(admin.response.user.id);
      await sql`update users set is_platform_admin = true where id = ${admin.response.user.id}`;
      const [{ id }] = await sql`select provision_brand(${`owner-${crypto.randomUUID()}`}, 'Owner invitation') as id`;
      workspaces.push(id);
      const email = `owner-${crypto.randomUUID()}@example.test`;
      const headers = { Authorization: `Bearer ${admin.headers.get('set-auth-token')}`, 'Content-Type': 'application/json' };
      const invite = () => god.request(`/brands/${id}/invite`, { method: 'POST', headers, body: JSON.stringify({ email }) });
      const first = await (await invite()).json() as any;
      users.push(first.user_id);
      expect(first.email_sent).toBe(true);
      expect(first.invitation_type).toBe('setup');
      const link = new URL(first.invite_link);
      expect(link.search).toBe('?invitation=1');
      expect(link.hash).toBe(`#/w/${id}/dashboard`);
      expect(mail[0].TextBody).toContain('reset_token=');
      expect(JSON.stringify(first)).not.toContain('reset_token');
      const tokenCount = async () => (await sql`select count(*)::int as count from verification where value = ${first.user_id}`)[0].count;
      const before = await tokenCount();
      const second = await (await invite()).json() as any;
      expect(second.email_sent).toBe(true);
      expect(second.invitation_type).toBe('setup');
      expect(second.invite_link).toBe(first.invite_link);
      expect(mail[1].TextBody).toContain('reset_token=');
      expect(await tokenCount()).toBeGreaterThan(before);
      fail = true;
      expect((await (await invite()).json() as any).email_sent).toBe(false);
      fail = false;
      const setupToken = new URL(mail[1].TextBody.match(/https:\/\/\S+reset_token=\S+/)[0]).searchParams.get('reset_token')!;
      await auth.api.resetPassword({ body: { token: setupToken, newPassword: 'Owner-password-123!' } });
      const verifiedCount = await tokenCount();
      const third = await (await invite()).json() as any;
      expect(third.invitation_type).toBe('sign_in');
      expect(mail.at(-1).TextBody).toContain(first.invite_link);
      expect(mail.at(-1).TextBody).not.toContain('reset_token');
      expect(await tokenCount()).toBe(verifiedCount);
      fail = true;
      const failed = await (await invite()).json() as any;
      expect(failed.email_sent).toBe(false);
      expect(failed.invite_link).toBe(first.invite_link);
    } finally {
      globalThis.fetch = oldFetch;
      env.POSTMARK_SERVER_TOKEN = oldToken;
      env.POSTMARK_OUTBOUND_FROM = oldFrom;
    }
  });
});
