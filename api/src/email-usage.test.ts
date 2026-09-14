import { afterAll, describe, expect, it } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=disable';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';
const { collectEmailUsage, usagePeriod, usageThreshold, usageState, runEmailUsageJob, readEmailUsage } = await import('./lib/email-usage.js');
const { env } = await import('./lib/env.js');
const original = { ...env };
afterAll(() => Object.assign(env, original));

describe('email usage arithmetic', () => {
  it('uses Eastern renewal midnight, rather than UTC midnight', () => {
    expect(usagePeriod(new Date('2026-09-14T03:59:59Z'), 14).start).toBe('2026-08-14');
    expect(usagePeriod(new Date('2026-09-14T04:00:00Z'), 14).start).toBe('2026-09-14');
    expect(usagePeriod(new Date('2026-01-14T04:59:59Z'), 14).start).toBe('2025-12-14');
  });
  it('clamps short months without permanently moving a 31st renewal', () => {
    expect(usagePeriod(new Date('2026-02-28T12:00:00Z'), 31)).toEqual({ start: '2026-02-28', end: '2026-03-31', today: '2026-02-28' });
    expect(usagePeriod(new Date('2024-02-29T12:00:00Z'), 31).start).toBe('2024-02-29');
    expect(() => usagePeriod(new Date(), 0)).toThrow();
  });
  it('warns at exact thresholds and keeps overages at the highest threshold', () => {
    expect([7999, 8000, 8999, 9000, 10000, 11000].map(n => usageThreshold(n, 10000))).toEqual([0, 80, 80, 90, 100, 100]);
  });
});

function mockProvider(fail = '') {
  const calls: string[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const headers = new Headers(init?.headers);
    if (url.pathname === '/servers') {
      expect(headers.get('X-Postmark-Account-Token')).toBe('account-secret');
      const offset = Number(url.searchParams.get('offset'));
      // Deliberately partial pages: collector must follow TotalCount.
      return Response.json({ TotalCount: 2, Servers: [{ ID: offset + 1, ApiTokens: [`server-${offset + 1}`], Name: 'not returned to users' }] });
    }
    expect(headers.has('X-Postmark-Account-Token')).toBe(false);
    const second = headers.get('X-Postmark-Server-Token') === 'server-2';
    if (fail && second) return new Response('sensitive provider body', { status: 503 });
    if (url.pathname === '/message-streams') return Response.json({ TotalCount: 3, MessageStreams: [
      { ID: 'outbound', MessageStreamType: 'Transactional' },
      { ID: 'archived', MessageStreamType: 'Broadcasts' },
      { ID: 'inbound', MessageStreamType: 'Inbound' },
    ] });
    if (url.pathname === '/messages/outbound') {
      const archived = url.searchParams.get('messagestream') === 'archived';
      return Response.json({ TotalCount: 1, Messages: [{ MessageID: `${second}/${archived}`, Recipients: Array(archived ? 500 : second ? 2500 : 4000).fill('test@example.invalid') }] });
    }
    return Response.json({ TotalCount: second ? 200 : 300 });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('Postmark account collection', () => {
  it('includes every paginated server and both directions without exposing tokens', async () => {
    const { fetcher, calls } = mockProvider();
    const result = await collectEmailUsage('account-secret', 10000, 14, new Date('2026-09-15T12:00:00Z'), fetcher);
    expect(result).toEqual({ start: '2026-09-14', end: '2026-10-14', allowance: 10000, servers: 2, inbound: 500, outbound: 7500, total: 8000, threshold: 80 });
    expect(calls).toContain('/servers?count=100&offset=1');
    expect(calls.some(c => c.includes('todate=2026-09-15T23:59:59'))).toBe(true);
    expect(calls.some(c => c.includes('IncludeArchivedStreams=true'))).toBe(true);
    expect(calls.some(c => c.includes('messagestream=archived'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('ApiTokens');
  });
  it('rejects partial results instead of reporting a falsely low usage', async () => {
    await expect(collectEmailUsage('account-secret', 10000, 14, new Date(), mockProvider('fail').fetcher)).rejects.toThrow('HTTP 503');
  });
  it('rejects malformed counts and duplicate server pages', async () => {
    const duplicate = (async () => Response.json({ TotalCount: 2, Servers: [{ ID: 1, ApiTokens: ['secret'] }] })) as unknown as typeof fetch;
    await expect(collectEmailUsage('account-secret', 10000, 14, new Date(), duplicate)).rejects.toThrow('incomplete');
    const malformed = (async (url: Parameters<typeof fetch>[0]) => Response.json(String(url).includes('/servers?')
      ? { TotalCount: 1, Servers: [{ ID: 1, ApiTokens: ['secret'] }] } : { TotalCount: -1 })) as unknown as typeof fetch;
    await expect(collectEmailUsage('account-secret', 10000, 14, new Date(), malformed)).rejects.toThrow();
  });
  it('marks failed, old and previous-cycle data as unknown current usage', async () => {
    Object.assign(env, { POSTMARK_ACCOUNT_TOKEN: 'account-secret', EMAIL_USAGE_RENEWAL_DAY: 14, EMAIL_USAGE_ALLOWANCE: 10000 });
    const now = new Date('2026-09-15T12:00:00Z');
    const snapshot = await collectEmailUsage('account-secret', 10000, 14, now, mockProvider().fetcher);
    expect(usageState(snapshot, now, null, now)).toBe('warning');
    expect(usageState(snapshot, now, 'failed', now)).toBe('unavailable');
    expect(usageState(snapshot, new Date('2026-09-15T09:00:00Z'), null, now)).toBe('stale');
    expect(usageState(snapshot, now, null, new Date('2026-10-14T12:00:00Z'))).toBe('stale');
    expect(usageState(null, null, null, now)).toBe('pending');
    env.EMAIL_USAGE_RENEWAL_DAY = 0;
    expect(usageState(snapshot, now, null, now)).toBe('unconfigured');
  });
});

const dbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;
dbTests('email usage persistence and notifications', () => {
  it('restricts account-wide status to platform admins and protects the scheduled job', async () => {
    const app = (await import('./index.js')).default;
    const { auth } = await import('./lib/auth.js');
    const { getDb } = await import('./lib/db.js');
    const sql = getDb();
    const response = await auth.api.signUpEmail({ body: {
      email: `email-usage-${Date.now()}@example.invalid`, password: 'test-password-12345', name: 'Usage test',
    } });
    const headers = { Authorization: `Bearer ${response.token}` };
    try {
      expect((await app.request('/api/v1/god/email-usage')).status).toBe(401);
      expect((await app.request('/api/v1/god/email-usage', { headers })).status).toBe(403);
      await sql`update users set is_platform_admin=true where id=${response.user.id}`;
      const allowed = await app.request('/api/v1/god/email-usage', { headers });
      expect(allowed.status).toBe(200);
      expect(JSON.stringify(await allowed.json())).not.toContain('ApiTokens');
      expect((await app.request('/api/v1/cron/email-usage')).status).toBe(401);
      expect((await app.request('/api/v1/cron/email-usage', { headers: { Authorization: 'Bearer wrong-token' } })).status).toBe(401);
    } finally { await sql`delete from users where id=${response.user.id}`; }
  });
  it('deduplicates across runs, retries Slack failure, and retains last good data on provider failure', async () => {
    const { getDb } = await import('./lib/db.js');
    const sql = getDb();
    const savedFetch = globalThis.fetch;
    const [saved] = await sql`select * from email_usage_monitor where singleton`;
    let slackCalls = 0, slackOk = false, providerOk = true;
    Object.assign(env, { POSTMARK_ACCOUNT_TOKEN: 'account-secret', EMAIL_USAGE_RENEWAL_DAY: 14, EMAIL_USAGE_ALLOWANCE: 10000, EMAIL_USAGE_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/test-only' });
    const provider = mockProvider().fetcher;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith('https://hooks.slack.com/')) {
        slackCalls++;
        expect(String(init?.body)).not.toContain('account-secret');
        return new Response('', { status: slackOk ? 200 : 503 });
      }
      if (!providerOk) throw new Error('sensitive token: never publish this');
      return provider(input, init);
    }) as typeof fetch;
    try {
      await sql`update email_usage_monitor set snapshot=null, checked_at=null, notified_cycle=null, notified_threshold=0 where singleton`;
      expect((await runEmailUsageJob()).ok).toBe(false);
      expect((await readEmailUsage()).snapshot.total).toBe(8000);
      slackOk = true;
      expect((await runEmailUsageJob()).ok).toBe(true);
      expect((await runEmailUsageJob()).ok).toBe(true);
      expect(slackCalls).toBe(2);
      env.EMAIL_USAGE_ALLOWANCE = 8000;
      expect((await runEmailUsageJob()).ok).toBe(true);
      expect(slackCalls).toBe(3);
      expect((await runEmailUsageJob()).ok).toBe(true);
      expect(slackCalls).toBe(3);
      providerOk = false;
      expect((await runEmailUsageJob()).ok).toBe(false);
      const status = await readEmailUsage();
      expect(status.state).toBe('unavailable');
      expect(status.snapshot.total).toBe(8000);
      expect(JSON.stringify(status)).not.toContain('sensitive token');
    } finally {
      globalThis.fetch = savedFetch;
      await sql`update email_usage_monitor set snapshot=${saved.snapshot ? sql.json(saved.snapshot) : null}, checked_at=${saved.checked_at}, attempted_at=${saved.attempted_at}, last_error=${saved.last_error}, notified_cycle=${saved.notified_cycle}, notified_threshold=${saved.notified_threshold} where singleton`;
    }
  });
});
