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
  it('tests only the authorized workspace saved connection and reports delivery honestly', async () => {
    const originalFetch = globalThis.fetch;
    const calls: { url: string; init?: RequestInit }[] = [];
    let reply = () => Promise.resolve(new Response('ok'));
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return reply();
    }) as typeof fetch;
    const send = (user = 0) => app.request('/api/v1/integrations/slack/test', {
      method: 'POST', headers: { Authorization: `Bearer ${users[user].token}`, 'X-Workspace-Id': workspaceId },
    });
    try {
      expect((await app.request('/api/v1/integrations/slack/test', { method: 'POST' })).status).toBe(401);
      expect((await app.request('/api/v1/integrations/slack/test', {
        method: 'POST', headers: { Authorization: `Bearer ${users[0].token}`, 'X-Workspace-Id': crypto.randomUUID() },
      })).status).toBe(403);
      expect((await send(1)).status).toBe(403);
      expect((await send()).status).toBe(400);
      await request(0, 'PUT', { webhook_url: webhook, events, active: false });
      expect((await send()).status).toBe(400);
      expect(calls).toHaveLength(0);
      await request(0, 'PUT', { events, active: true });
      expect((await send()).status).toBe(200);
      expect(calls[0].url).toBe(webhook);
      expect(calls[0].init?.redirect).toBe('error');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'Respovia test alert: your saved Slack connection is working.' });
      reply = () => Promise.resolve(new Response('invalid', { status: 403 }));
      expect((await send()).status).toBe(502);
      await request(0, 'PUT', { events, bot_token: bot, channel: 'C-test' });
      reply = () => Promise.resolve(Response.json({ ok: true }));
      expect((await send()).status).toBe(200);
      expect(calls.at(-1)?.url).toBe('https://slack.com/api/chat.postMessage');
      expect(JSON.parse(String(calls.at(-1)?.init?.body)).channel).toBe('C-test');
      reply = () => Promise.resolve(Response.json({ ok: false, error: bot }));
      const rejected = await send();
      expect(rejected.status).toBe(502);
      expect(await rejected.text()).not.toContain(bot);
      reply = () => Promise.reject(new Error(webhook));
      const before = calls.length;
      const uncertain = await send();
      expect(uncertain.status).toBe(502);
      expect(await uncertain.text()).toContain('Check Slack before trying again');
      expect(calls).toHaveLength(before + 1);
      await sql`update workspaces set suspended_at=now() where id=${workspaceId}`;
      expect((await send()).status).toBe(403);
      expect(calls).toHaveLength(before + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
