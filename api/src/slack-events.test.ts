// DB-backed tests for the Slack inbound-event handler's team_id fast path
// (advisory #14): signature verification picks the candidate by team_id and
// lazily backfills it, instead of scanning every workspace's signing secret.
//
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/slack-events.test.ts

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('slack /events signature verification (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  const RUN = Date.now();
  const A = { slug: `slk-a-${RUN}`, secret: `secret-a-${RUN}-aaaaaaaa`, team: `T-A-${RUN}` } as Record<string, string>;
  const B = { slug: `slk-b-${RUN}`, secret: `secret-b-${RUN}-bbbbbbbb`, team: `T-B-${RUN}` } as Record<string, string>;

  // Mirror Slack's signing: v0=HMAC-SHA256(secret, `v0:${ts}:${rawBody}`).
  function sign(secret: string, rawBody: string) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex');
    return { ts, sig };
  }
  function postEvent(secret: string | null, body: unknown) {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) {
      const { ts, sig } = sign(secret, raw);
      headers['x-slack-request-timestamp'] = ts;
      headers['x-slack-signature'] = sig;
    }
    return app.request('/api/v1/webhooks/slack/events', { method: 'POST', headers, body: raw });
  }
  const event = (team: string) => ({ type: 'event_callback', team_id: team, event: { type: 'message', text: 'hi' } });
  const teamIdOf = async (slug: string) => {
    const [row] = await sql<{ team_id: string | null }[]>`
      select si.team_id from slack_integrations si
      join workspaces w on w.id = si.workspace_id where w.slug = ${slug}
    `;
    return row?.team_id ?? null;
  };

  async function setupSlackWs(t: Record<string, string>) {
    const [{ provision_brand: wsId }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${t.slug}, ${t.slug}) as provision_brand
    `;
    t.wsId = wsId;
    await sql`
      insert into slack_integrations (workspace_id, webhook_url, signing_secret, active, events)
      values (${wsId}, 'https://hooks.slack.com/services/x', ${t.secret}, true, '{}')
    `;
  }

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    await setupSlackWs(A);
    await setupSlackWs(B);
  });

  afterAll(async () => {
    if (sql) await sql`delete from workspaces where id in ${sql([A.wsId, B.wsId].filter(Boolean))}`;
  });

  it('url_verification returns the challenge without a signature', async () => {
    const res = await postEvent(null, { type: 'url_verification', challenge: `c-${RUN}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge?: string };
    expect(body.challenge).toBe(`c-${RUN}`);
  });

  it('verifies a signed event and backfills team_id (fallback path)', async () => {
    expect(await teamIdOf(A.slug)).toBeNull(); // not tagged yet
    const res = await postEvent(A.secret, event(A.team));
    expect(res.status).toBe(200);
    expect(await teamIdOf(A.slug)).toBe(A.team); // backfilled
  });

  it('verifies a second event via the O(1) team_id fast path', async () => {
    const res = await postEvent(A.secret, event(A.team));
    expect(res.status).toBe(200);
    expect(await teamIdOf(A.slug)).toBe(A.team);
  });

  it('rejects an event with a bad signature (401)', async () => {
    const raw = JSON.stringify(event(B.team));
    const res = await app.request('/api/v1/webhooks/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-slack-request-timestamp': Math.floor(Date.now() / 1000).toString(), 'x-slack-signature': 'v0=deadbeef' },
      body: raw,
    });
    expect(res.status).toBe(401);
  });
});
