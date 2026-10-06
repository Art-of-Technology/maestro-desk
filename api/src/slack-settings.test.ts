import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const dbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
dbTests('Slack settings keep credentials server-side', () => {
  let app: typeof import('./index.js').default;
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let workspaceId: string;
  const users: { id: string; token: string }[] = [];
  const webhook = 'https://hooks.slack.com/services/T-test/B-test/secret-test';
  const bot = 'xoxb-test-secret-123456';
  const signing = 'test-signing-secret-123456';
  const events = ['ticket.created'];
  const request = (user: number, method = 'GET', body?: unknown) => app.request('/api/v1/integrations/slack', {
    method, headers: { Authorization: `Bearer ${users[user].token}`, 'X-Workspace-Id': workspaceId, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  beforeAll(async () => {
    app = (await import('./index.js')).default;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const run = crypto.randomUUID();
    [{ provision_brand: workspaceId }] = await sql`select provision_brand(${'slack-' + run}, 'Slack test')`;
    for (const admin of [true, false]) {
      const signed = await auth.api.signUpEmail({ body: { email: `slack-${admin}-${run}@example.test`, password: 'local-test-password-123', name: 'Test agent' } });
      users.push({ id: signed.user.id, token: signed.token! });
      const [role] = await sql`select id from roles where workspace_id=${workspaceId} and is_admin=${admin} limit 1`;
      await sql`insert into workspace_members (workspace_id,user_id,role_id,active) values (${workspaceId},${signed.user.id},${role.id},true)`;
    }
  });
  afterAll(async () => {
    if (workspaceId) await sql`delete from workspaces where id=${workspaceId}`;
    for (const user of users) await sql`delete from users where id=${user.id}`;
  });
  it('requires a URL for a new connection and prevents member writes', async () => {
    expect((await request(0, 'PUT', { events })).status).toBe(400);
    expect((await request(1, 'PUT', { webhook_url: webhook, events })).status).toBe(403);
    expect(await (await request(0)).json()).toEqual({ integration: null });
  });
  it('never returns a usable credential to members or administrators', async () => {
    expect((await request(0, 'PUT', { webhook_url: webhook, bot_token: bot, signing_secret: signing, events })).status).toBe(200);
    for (const user of [0, 1]) {
      const response = await request(user);
      expect(response.status).toBe(200);
      const body = await response.text();
      for (const secret of [webhook, bot, signing]) expect(body).not.toContain(secret);
      const { integration } = JSON.parse(body);
      expect(integration.webhook_url).toBeUndefined();
      expect(integration.has_webhook).toBe(true);
      expect(integration.has_bot_token).toBe(true);
      expect(integration.has_signing_secret).toBe(true);
    }
  });
  it('preserves credentials when editing settings, supports rotation, and cannot resurrect a disconnected connection', async () => {
    expect((await request(0, 'PUT', { channel: '#support', active: false, events })).status).toBe(200);
    const [saved] = await sql`select webhook_url,bot_token,signing_secret,channel,active from slack_integrations where workspace_id=${workspaceId}`;
    expect(saved).toEqual({ webhook_url: webhook, bot_token: bot, signing_secret: signing, channel: '#support', active: false });
    expect((await request(0, 'PUT', { webhook_url: '', events })).status).toBe(400);
    expect((await request(0, 'PUT', { webhook_url: 'https://hooks.slack.com.evil.test/x', events })).status).toBe(400);
    expect((await request(0, 'PUT', { webhook_url: webhook + '-rotated', events })).status).toBe(200);
    expect((await sql`select webhook_url from slack_integrations where workspace_id=${workspaceId}`)[0].webhook_url).toBe(webhook + '-rotated');
    expect((await request(1, 'DELETE')).status).toBe(403);
    expect((await request(0, 'DELETE')).status).toBe(204);
    expect((await request(0, 'PUT', { channel: '#stale-form', events })).status).toBe(400);
    expect(await (await request(0)).json()).toEqual({ integration: null });
  });
});
