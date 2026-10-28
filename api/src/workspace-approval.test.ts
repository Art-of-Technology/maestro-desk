import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const authModule = await import('./lib/auth.js');
mock.module('./lib/auth.js', () => ({ ...authModule, maestroSignInEnabled: true }));
const { env } = await import('./lib/env.js');
const { getDb } = await import('./lib/db.js');
const { requestBrandWorkspace, resolveBrandWorkspace, approveBrandWorkspace, setWorkspaceRegistration } = await import('./lib/maestro-workspace.js');
const app = (await import('./index.js')).default;

(process.env.RUN_DB_TESTS ? describe : describe.skip)('Maestro workspace approvals', () => {
  const sql = getDb();
  const org = { id: randomUUID(), name: 'Approval test organisation', slug: 'approval-org', role: 'OWNER' };
  const brand = { id: randomUUID(), name: 'Approval test brand', slug: 'approval-test', organizationId: org.id };
  const archived = { id: randomUUID(), name: 'Archived approval test', slug: 'archived-approval', organizationId: org.id };
  const unknown = { id: randomUUID(), name: 'Automatic test', slug: 'automatic-test', organizationId: org.id };
  const failedAlertBrand = { id: randomUUID(), name: 'Failed alert test', slug: 'failed-alert-test', organizationId: org.id };
  let accessibleBrands = [brand, archived, unknown];
  const slackWebhook = 'https://hooks.slack.com/services/approval-test';
  let slackCalls = 0, slackOk = true, requestCommittedBeforeAlert = false;
  const originalSlack = env.EMAIL_USAGE_SLACK_WEBHOOK_URL;
  const userIds: string[] = [];
  let admin: string, user: string, userToken: string, adminToken: string;
  let originalAutomatic: boolean;
  const originalFetch = globalThis.fetch;
  const authApi = authModule.auth.api as { getAccessToken: typeof authModule.auth.api.getAccessToken };
  const originalToken = authApi.getAccessToken;
  const originalClient = env.MAESTRO_CLIENT_ID;
  const originalSecret = env.MAESTRO_CLIENT_SECRET;
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const post = (path: string, token: string, body?: object) => app.request(path, {
    method: 'POST', headers: headers(token), body: body ? JSON.stringify(body) : undefined,
  });

  beforeAll(async () => {
    const [settings] = await sql`select automatic from workspace_registration_settings where id=true`;
    originalAutomatic = settings.automatic;
    for (const name of ['admin', 'agent', 'second']) {
      const session = await authModule.auth.api.signUpEmail({ body: {
        email: `approval-${name}-${randomUUID()}@test.invalid`, password: 'password-12345', name,
      } });
      userIds.push(session.user.id);
      await sql`insert into account ("accountId", "providerId", "userId", "updatedAt")
        values (${session.user.id}, 'maestro', ${session.user.id}, now())`;
      if (name === 'admin') { admin = session.user.id; adminToken = session.token!; }
      if (name === 'agent') { user = session.user.id; userToken = session.token!; }
    }
    await sql`update users set is_platform_admin=true where id=${admin}`;
    await setWorkspaceRegistration(false, admin);
    env.MAESTRO_CLIENT_ID = 'approval-test-client';
    env.MAESTRO_CLIENT_SECRET = 'approval-test-secret';
    env.EMAIL_USAGE_SLACK_WEBHOOK_URL = slackWebhook;
    authApi.getAccessToken = (async () => ({ accessToken: 'approval-test-token' })) as typeof originalToken;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url === `${env.MAESTRO_GATEWAY_URL}/api/v1/organizations`) return Response.json({ organizations: [org] });
      if (url === `${env.MAESTRO_GATEWAY_URL}/api/v1/organizations/${org.id}/brands`) return Response.json({ brands: accessibleBrands });
      if (url === slackWebhook) {
        slackCalls++;
        const saved = await sql`select maestro_brand_id from workspace_requests where maestro_brand_id=${brand.id}`;
        requestCommittedBeforeAlert = saved.length === 1;
        return new Response(slackOk ? 'ok' : 'failed', { status: slackOk ? 200 : 503 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const [ws] = await sql`select provision_brand('Archived approval test',${'archive-approval-' + archived.id.slice(0, 8)}) id`;
    await sql`update workspaces set maestro_brand_id=${archived.id},deleted_at=now() where id=${ws.id}`;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    authApi.getAccessToken = originalToken;
    env.MAESTRO_CLIENT_ID = originalClient;
    env.MAESTRO_CLIENT_SECRET = originalSecret;
    env.EMAIL_USAGE_SLACK_WEBHOOK_URL = originalSlack;
    await sql`delete from workspace_requests where maestro_brand_id in ${sql([brand.id, archived.id, unknown.id, failedAlertBrand.id])}`;
    await sql`delete from workspaces where maestro_brand_id in ${sql([brand.id, archived.id, unknown.id])}`;
    await sql`update workspace_registration_settings set automatic=${originalAutomatic},updated_by=null where id=true`;
    // Platform setting audit records retain their actor in this disposable database.
    await sql`delete from users where id in ${sql(userIds.filter(id => id !== admin))}`;
  });

  it('requires authentication and platform-admin permission for settings and approvals', async () => {
    for (const path of ['/api/v1/god/workspace-registration', `/api/v1/god/workspace-requests/${brand.id}/approve`]) {
      expect((await app.request(path)).status).toBe(401);
      expect((await app.request(path, { headers: headers(userToken) })).status).toBe(403);
    }
    expect((await post(`/api/v1/god/workspace-requests/${brand.id}/approve`, userToken)).status).toBe(403);
    expect((await app.request('/api/v1/god/workspace-registration', { method: 'PATCH', headers: headers(userToken), body: '{"automatic":true}' })).status).toBe(403);
    expect((await app.request('/api/v1/god/workspace-registration', { method: 'PATCH', headers: headers(adminToken), body: '{"automatic":"yes"}' })).status).toBe(400);
    accessibleBrands = [];
    const empty = await (await app.request('/api/v1/maestro/workspace', { headers: headers(userToken) })).json() as any;
    expect(empty.brands).toEqual([]);
    accessibleBrands = [brand, archived, unknown];
  });

  it('offers a request without creating a workspace or membership; direct selection cannot bypass approval', async () => {
    const list = await (await app.request('/api/v1/maestro/workspace', { headers: headers(userToken) })).json() as any;
    expect(list.brands.find((b: any) => b.id === brand.id).workspace_status).toBe('requestable');
    expect(list.brands.some((b: any) => b.id === archived.id)).toBe(false);
    expect((await post('/api/v1/maestro/select-brand', userToken, { brandId: brand.id })).status).toBe(403);
    expect((await sql`select id from workspaces where maestro_brand_id=${brand.id}`).length).toBe(0);
    expect((await sql`select workspace_id from workspace_members where user_id=${user}`).length).toBe(0);
  });

  it('validates brand access and ignores client-supplied requester, organisation and approval fields', async () => {
    expect((await post('/api/v1/maestro/workspace-requests', userToken, { brandId: randomUUID() })).status).toBe(403);
    expect((await post('/api/v1/maestro/workspace-requests', userToken, { brandId: brand.id, requester_id: admin, approved: true })).status).toBe(400);
    expect((await post('/api/v1/maestro/workspace-requests', userToken, { brandId: 'invalid' })).status).toBe(400);
    expect((await post('/api/v1/maestro/workspace-requests', userToken, { brandId: archived.id })).status).toBe(409);
  });

  it('deduplicates concurrent requests and uses verified Maestro names', async () => {
    const replies = await Promise.all(Array.from({ length: 4 }, () => post('/api/v1/maestro/workspace-requests', userToken, { brandId: brand.id })));
    expect(replies.every(r => r.status === 200)).toBe(true);
    const requests = await sql`select * from workspace_requests where maestro_brand_id=${brand.id}`;
    expect(requests.length).toBe(1);
    expect(requests[0].requester_id).toBe(user);
    expect(requests[0].organization_name).toBe(org.name);
    expect(slackCalls).toBe(1);
    expect(requestCommittedBeforeAlert).toBe(true);
    expect((await sql`select id from workspaces where maestro_brand_id=${brand.id}`).length).toBe(0);
    const list = await (await app.request('/api/v1/maestro/workspace', { headers: headers(userToken) })).json() as any;
    expect(list.brands.find((b: any) => b.id === brand.id).workspace_status).toBe('pending');
  });

  it('keeps requests pending on Slack failure and does not resend on duplicate submissions', async () => {
    accessibleBrands = [brand, archived, unknown, failedAlertBrand];
    slackOk = false;
    try {
      expect((await post('/api/v1/maestro/workspace-requests', userToken, { brandId: failedAlertBrand.id })).status).toBe(200);
      const [request] = await sql`select approved_at from workspace_requests where maestro_brand_id=${failedAlertBrand.id}`;
      expect(request.approved_at).toBeNull();
      expect((await sql`select id from workspaces where maestro_brand_id=${failedAlertBrand.id}`).length).toBe(0);
      expect(slackCalls).toBe(2);
      expect((await post('/api/v1/maestro/workspace-requests', userToken, { brandId: failedAlertBrand.id })).status).toBe(200);
      expect(slackCalls).toBe(2);
    } finally {
      slackOk = true;
      accessibleBrands = [brand, archived, unknown];
    }
  });

  it('Automatic allows new brands but keeps existing requests pending and archives blocked', async () => {
    expect((await app.request('/api/v1/god/workspace-registration', {
      method: 'PATCH', headers: headers(adminToken), body: '{"automatic":true}',
    })).status).toBe(200);
    await expect(resolveBrandWorkspace(user, brand, 'Admin')).rejects.toThrow('awaiting approval');
    const memberships = await Promise.all(Array.from({ length: 3 }, () => resolveBrandWorkspace(user, unknown, 'Admin')));
    expect(new Set(memberships.map(m => m.workspace_id)).size).toBe(1);
    expect((await sql`select id from workspaces where maestro_brand_id=${unknown.id}`).length).toBe(1);
    await expect(resolveBrandWorkspace(user, archived, 'Admin')).rejects.toThrow('archived');
    await setWorkspaceRegistration(false, admin);
    expect((await resolveBrandWorkspace(user, unknown, 'Admin')).active).toBe(true);
  });

  it('approval creates one workspace, audits once and grants no membership until verified login', async () => {
    const replies = await Promise.all(Array.from({ length: 3 }, () => post(`/api/v1/god/workspace-requests/${brand.id}/approve`, adminToken)));
    expect(replies.every(r => r.status === 200)).toBe(true);
    const [ws] = await sql`select id from workspaces where maestro_brand_id=${brand.id}`;
    expect((await sql`select workspace_id from workspace_members where workspace_id=${ws.id}`).length).toBe(0);
    expect((await sql`select id from audit_events where workspace_id=${ws.id} and action='workspace_request.approved'`).length).toBe(1);
    accessibleBrands = [archived, unknown];
    expect((await post('/api/v1/maestro/select-brand', userToken, { brandId: brand.id })).status).toBe(403);
    expect((await sql`select workspace_id from workspace_members where workspace_id=${ws.id}`).length).toBe(0);
    accessibleBrands = [brand, archived, unknown];
    expect((await post('/api/v1/maestro/select-brand', userToken, { brandId: brand.id })).status).toBe(200);
    await sql`update workspace_members set active=false where workspace_id=${ws.id} and user_id=${user}`;
    expect((await post('/api/v1/maestro/select-brand', userToken, { brandId: brand.id })).status).toBe(403);
    const list = await (await app.request('/api/v1/god/workspace-registration', { headers: headers(adminToken) })).json() as any;
    expect(list.requests.some((r: any) => r.maestro_brand_id === brand.id)).toBe(false);
  });

  it('does not resurrect an approved workspace after archival', async () => {
    await sql`update workspaces set deleted_at=now() where maestro_brand_id=${brand.id}`;
    await expect(approveBrandWorkspace(brand.id, admin)).rejects.toThrow('archived or suspended');
    await expect(requestBrandWorkspace(user, brand, org.name)).rejects.toThrow('already has');
  });

  it('archives only the named extra brand and preserves its records on repeat execution', async () => {
    const migration = readFileSync(new URL('../../db/migrations/20261021140000_workspace_approval.sql', import.meta.url), 'utf8');
    const archiveSql = migration.slice(migration.indexOf('-- Keep the archived mapping'));
    const rollback = new Error('rollback archive fixture');
    try {
      await sql.begin(async tx => {
        for (const [name, slug] of [['Space Casino', 'spacecasino'], ['Test Casino', 'test-casino']]) {
          if (!(await tx`select id from workspaces where slug=${slug}`).length) await tx`select provision_brand(${name},${slug})`;
        }
        const [target] = await tx`select provision_brand('TestNewPageBuilderBrand','testnewpagebuilderbrand-237301e6') id`;
        await tx`insert into workspace_members(workspace_id,user_id,role_id,active)
          select ${target.id},${user},id,true from roles where workspace_id=${target.id} and name='Admin'`;
        await tx.unsafe(archiveSql);
        await tx.unsafe(archiveSql);
        expect((await tx`select id from workspaces where id=${target.id} and deleted_at is not null`).length).toBe(1);
        expect((await tx`select user_id from workspace_members where workspace_id=${target.id}`).length).toBe(1);
        expect((await tx`select id from audit_events where workspace_id=${target.id} and action='brand.archived'`).length).toBe(1);
        expect((await tx`select id from workspaces where slug in ('spacecasino','test-casino') and deleted_at is null and suspended_at is null`).length).toBe(2);
        throw rollback;
      });
    } catch (e) { if (e !== rollback) throw e; }
  });
});

afterAll(() => { mock.module('./lib/auth.js', () => authModule); mock.restore(); });
