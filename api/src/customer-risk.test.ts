import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { amlLevel } from './lib/customer-risk.js';

const BRAND = '58d5016a-91bb-49e6-a9be-b3f36f08afde';
describe('AML mapping', () => {
  it('maps only verified Space Casino values, including zero', () => {
    for (const [value, level] of [[0, 'low'], [1, 'medium'], [2, 'high']] as const) {
      expect(amlLevel(BRAND, value)).toBe(level);
      expect(amlLevel(BRAND, String(value))).toBe(level);
    }
    for (const value of [null, undefined, '', ' ', false, 3, -1, 'unknown', {}, []]) {
      expect(amlLevel(BRAND, value)).toBeNull();
    }
    expect(amlLevel('another-brand', 0)).toBeNull();
  });
});

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
runDbTests('customer risk endpoint', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const realFetch = globalThis.fetch;
  const ctx = {} as Record<string, string>;
  const run = Date.now();
  let calls = 0;

  const request = (id = ctx.customer, ws = ctx.workspace, token = ctx.token) => app.request(`/api/v1/customers/${id}/risk`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws, 'X-Brand-Id': 'untrusted-brand' },
  });

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    const { auth } = await import('./lib/auth.js');
    const signup: any = await auth.api.signUpEmail({ body: {
      email: `risk-${run}@test.example`, password: 'test-password-12345', name: 'Risk test',
    }, returnHeaders: true });
    ctx.user = signup.response.user.id; ctx.token = signup.response.token;
    for (const key of ['workspace', 'other']) {
      const [row] = await sql`select provision_brand(${'risk-' + key + run}, ${'risk-' + key + run}) as id`;
      ctx[key] = row.id;
    }
    const [role] = await sql`select id from roles where workspace_id = ${ctx.workspace} and is_admin = true limit 1`;
    await sql`insert into workspace_members (workspace_id, user_id, role_id, active)
      values (${ctx.workspace}, ${ctx.user}, ${role.id}, true)`;
    await sql`update workspaces set maestro_brand_id = ${BRAND} where id = ${ctx.workspace}`;
    const [customer] = await sql`insert into customers (workspace_id, display_id, maestro_user_id)
      values (${ctx.workspace}, 'M-RISK', '50119') returning id`;
    ctx.customer = customer.id;
    const [other] = await sql`insert into customers (workspace_id, display_id)
      values (${ctx.other}, 'M-RISK') returning id`;
    ctx.otherCustomer = other.id;
  }, 30000);

  beforeEach(() => {
    calls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(String(input)).toContain('memberId=50119');
      expect(new Headers(init?.headers).get('X-Brand-Id')).toBe(BRAND);
      return Response.json({ success: true, userId: '50119', attributes: { amlRiskLevel: 0 }, email: 'private@example.test' });
    }) as unknown as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await sql`delete from workspaces where id in (${ctx.workspace}, ${ctx.other})`;
    await sql`delete from users where id = ${ctx.user}`;
  });

  it('denies unauthorized, wrong-workspace and missing records before looking up risk', async () => {
    expect((await request(ctx.customer, ctx.workspace, '')).status).toBe(401);
    expect((await request(ctx.otherCustomer)).status).toBe(404);
    expect((await request(ctx.customer, ctx.other)).status).toBe(403);
    expect((await request('not-a-uuid')).status).toBe(404);
    expect(calls).toBe(0);
  });

  it('counts full complaint history using workspace terminal statuses and creation dates', async () => {
    await sql`insert into ticket_statuses (workspace_id, key, label, is_terminal)
      values (${ctx.workspace}, 'finished-custom', 'Finished', true)`;
    await sql`insert into tickets (workspace_id, customer_id, display_id, subject, category_key, status_key, priority_key, created_at)
      select ${ctx.workspace}, ${ctx.customer}, 'RISK-' || n, 'Test', 'Complaints', 'open', 'normal', now() - interval '40 days'
      from generate_series(1, 60) n`;
    await sql`insert into tickets (workspace_id, customer_id, display_id, subject, category_key, status_key, priority_key, created_at)
      values (${ctx.workspace}, ${ctx.customer}, 'RECENT', 'Test', 'Complaints', 'finished-custom', 'normal', now() - interval '1 day'),
        (${ctx.workspace}, ${ctx.customer}, 'OLD-CLOSED', 'Test', 'Complaints', 'finished-custom', 'normal', now() - interval '40 days'),
        (${ctx.workspace}, ${ctx.customer}, 'OTHER-CAT', 'Test', 'General', 'open', 'normal', now()),
        (${ctx.other}, ${ctx.otherCustomer}, 'OTHER-WS', 'Test', 'Complaints', 'open', 'normal', now())`;
    // A merged source and a deleted complaint must not count. Updating an old
    // ticket must not make it a newly-created complaint.
    const [target] = await sql`select id from tickets where workspace_id = ${ctx.workspace} and display_id = 'RECENT'`;
    await sql`update tickets set merged_into_id = ${target.id} where workspace_id = ${ctx.workspace} and display_id = 'RISK-1'`;
    await sql`update tickets set deleted_at = now() where workspace_id = ${ctx.workspace} and display_id = 'RISK-2'`;
    await sql`update tickets set updated_at = now() where workspace_id = ${ctx.workspace} and display_id = 'OLD-CLOSED'`;
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as any;
    expect(body.complaints).toEqual({ open: 58, created_last_30_days: 1 });
    expect(body.aml).toEqual({ state: 'available', level: 'low' });
    expect(body.rg.state).toBe('unavailable');
    expect(body.cdd.state).toBe('unavailable');
    expect(body.closed_account.state).toBe('unavailable');
    expect(JSON.stringify(body)).not.toContain('private@example.test');
    const [audit] = await sql`select metadata from audit_events where workspace_id = ${ctx.workspace}
      and action = 'customer.risk_viewed' order by created_at desc limit 1`;
    expect(audit.metadata).toEqual({ accessed: ['aml'] });
  });

  it('keeps complaint counts when the provider fails or sends unknown risk or identity', async () => {
    for (const reply of [new Response('', { status: 503 }), Response.json({ success: true, userId: '50119', attributes: { amlRiskLevel: 3 } }),
      Response.json({ success: true, userId: 'someone-else', attributes: { amlRiskLevel: 0 } })]) {
      globalThis.fetch = (async () => reply) as unknown as typeof fetch;
      const response = await request();
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.aml).toEqual({ state: 'unavailable', level: null });
      expect(body.complaints.open).toBe(58);
    }
  });

  it('never looks up an unlinked, erased or merged customer', async () => {
    await sql`update customers set maestro_user_id = null where id = ${ctx.customer}`;
    expect(((await (await request()).json()) as any).aml.state).toBe('unavailable');
    await sql`update customers set maestro_user_id = '50119', erased_at = now() where id = ${ctx.customer}`;
    expect((await request()).status).toBe(404);
    await sql`update customers set erased_at = null, merged_into_customer_id = ${ctx.otherCustomer} where id = ${ctx.customer}`;
    expect((await request()).status).toBe(404);
    await sql`update customers set merged_into_customer_id = null where id = ${ctx.customer}`;
    expect(calls).toBe(0);
  });

  it('discards a lookup that finishes after the customer is erased', async () => {
    globalThis.fetch = (async () => {
      await sql`update customers set erased_at = now() where id = ${ctx.customer}`;
      return Response.json({ success: true, userId: '50119', attributes: { amlRiskLevel: 2 } });
    }) as unknown as typeof fetch;
    expect((await request()).status).toBe(404);
  });
});
