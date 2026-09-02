// lib/player-identity — automatic contact ↔ Maestro player linking.
//
// The gateway is stubbed via globalThis.fetch (the convention for Maestro in
// this suite — lib/maestro.js is never mocked). MAESTRO_API_TOKEN comes from
// test-setup.ts (the bun preload) so workerMaestroConfigured() is true.
//
// DB-backed part — local recipe:
//   docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=maestro_test -p 5432:5432 postgres:17
//   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/maestro_test?sslmode=disable' bun run migrate
//   RUN_DB_TESTS=1 DATABASE_URL='…?sslmode=disable' bun test src/player-identity.test.ts

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { memberNotFound } from './lib/player-identity.js';

describe('memberNotFound', () => {
  it('treats the 200 not-found envelope and empty bodies as not found', () => {
    expect(memberNotFound(null)).toBe(true);
    expect(memberNotFound(undefined)).toBe(true);
    expect(memberNotFound({ success: false })).toBe(true);
    expect(memberNotFound({ errorCode: 101 })).toBe(true);
    expect(memberNotFound({ userId: 'u1', email: 'a@b.c' })).toBe(false);
  });
});

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('player identity linking (DB-backed)', () => {
  type Lib = typeof import('./lib/player-identity.js');
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let lib: Lib;

  const RUN = Date.now();
  const brand = randomUUID();
  let ws = '';        // a Maestro-brand workspace
  let wsNoBrand = ''; // a legacy / non-Maestro workspace
  const realFetch = globalThis.fetch;

  // Every stubbed gateway call is recorded (url + X-Brand-Id) so tests can
  // assert WHETHER we called out and WHICH brand we scoped the lookup to.
  let calls: { url: string; brandId: string | null }[] = [];
  function stubGateway(body: Record<string, unknown> | null, status = 200) {
    calls = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, brandId: new Headers(init?.headers).get('x-brand-id') });
      const payload = body ?? { success: false, errorCode: 101 };
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }

  const PLAYER = {
    userId: 'a1b2c3d4-user-0001', memberId: 4711, username: 'ferit_bey',
    firstName: 'S. Ferit', lastName: 'Arslan', email: `player-${RUN}@example.test`,
    vipLevel: 'Gold', country: 'TR', balance: '12.50', balanceCy: 'EUR',
  };

  async function mkCustomer(wsId: string, email: string | null, extra: Record<string, unknown> = {}): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into customers ${sql({
        workspace_id: wsId,
        display_id: 'M-' + randomUUID().slice(0, 8),
        first_name: 'Stub', last_name: 'Contact',
        email,
        ...extra,
      })}
      returning id
    `;
    return row.id;
  }
  async function row(id: string) {
    const [r] = await sql<{
      username: string | null; vip_tier: string | null; jurisdiction: string | null;
      maestro_user_id: string | null; maestro_member_id: string | null; player_lookup_at: Date | null;
    }[]>`
      select username, vip_tier, jurisdiction, maestro_user_id, maestro_member_id, player_lookup_at
      from customers where id = ${id}
    `;
    return r;
  }

  beforeAll(async () => {
    sql = (await import('./lib/db.js')).getDb();
    lib = await import('./lib/player-identity.js');
    const [{ a }] = await sql<{ a: string }[]>`select provision_brand(${'pi-' + RUN}, ${'pi-' + RUN}) as a`;
    const [{ b }] = await sql<{ b: string }[]>`select provision_brand(${'pinb-' + RUN}, ${'pinb-' + RUN}) as b`;
    ws = a; wsNoBrand = b;
    await sql`update workspaces set maestro_brand_id = ${brand} where id = ${ws}`;
  }, 30000);

  afterEach(() => { globalThis.fetch = realFetch; });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!sql) return;
    for (const id of [ws, wsNoBrand].filter(Boolean)) {
      await sql`delete from customers where workspace_id = ${id}`;
      await sql`delete from workspaces where id = ${id}`;
    }
  });

  it('links ids, fills blank username/VIP/country, scopes the lookup to the workspace brand, and audits as system', async () => {
    stubGateway(PLAYER);
    const id = await mkCustomer(ws, PLAYER.email);

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('linked');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/v1/proxy/member/lookup');
    expect(calls[0].brandId).toBe(brand);

    const r = await row(id);
    expect(r.maestro_user_id).toBe(PLAYER.userId);
    expect(r.maestro_member_id).toBe('4711');       // numeric → text
    expect(r.username).toBe('ferit_bey');
    expect(r.vip_tier).toBe('Gold');
    expect(r.jurisdiction).toBe('TR');
    expect(r.player_lookup_at).not.toBeNull();

    const audits = await sql<{ actor_user_id: string | null; metadata: Record<string, unknown> }[]>`
      select actor_user_id, metadata from audit_events
      where workspace_id = ${ws} and action = 'customer.player_linked' and target_id = ${id}
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_user_id).toBeNull();
    expect(audits[0].metadata.brand_id).toBe(brand);
    expect(audits[0].metadata.reason).toBe('inbound_email');
    expect(audits[0].metadata.accessed).toEqual(['contact', 'vip']);
    // Never the values themselves.
    expect(JSON.stringify(audits[0].metadata)).not.toContain('12.50');
  });

  it('never overwrites an agent-entered username / VIP / country', async () => {
    const email = `typed-${RUN}@example.test`;
    stubGateway({ ...PLAYER, email });
    const id = await mkCustomer(ws, email, { username: 'agent_typed', vip_tier: 'Platinum', jurisdiction: 'MT' });

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'portal' })).toBe('linked');

    const r = await row(id);
    expect(r.maestro_user_id).toBe(PLAYER.userId);
    expect(r.username).toBe('agent_typed');
    expect(r.vip_tier).toBe('Platinum');
    expect(r.jurisdiction).toBe('MT');
  });

  it('not-found stamps the lookup and is not re-asked within the TTL', async () => {
    stubGateway(null);   // { success:false, errorCode:101 }
    const email = `nobody-${RUN}@example.test`;
    const id = await mkCustomer(ws, email);

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('not_found');
    expect(calls).toHaveLength(1);
    let r = await row(id);
    expect(r.maestro_user_id).toBeNull();
    expect(r.player_lookup_at).not.toBeNull();

    // Second email the same day: no gateway call at all (even though the
    // player now "exists" upstream).
    stubGateway({ ...PLAYER, email });
    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('skipped');
    expect(calls).toHaveLength(0);

    // Once the stamp is older than the TTL we ask again.
    await sql`update customers set player_lookup_at = now() - interval '2 days' where id = ${id}`;
    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('linked');
    r = await row(id);
    expect(r.maestro_user_id).toBe(PLAYER.userId);
  });

  it('rejects a member matched on username rather than email (nothing written, lookup stamped)', async () => {
    // The gateway's `email` param also matches usernames: a contact whose
    // address equals some player's username must NOT be linked to that player.
    stubGateway({ ...PLAYER, email: 'someone-else@example.test' });
    const id = await mkCustomer(ws, `lookalike-${RUN}@example.test`);

    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('email_mismatch');
    const r = await row(id);
    expect(r.maestro_user_id).toBeNull();
    expect(r.username).toBeNull();
    expect(r.player_lookup_at).not.toBeNull();
  });

  it('matches the email case-insensitively', async () => {
    const email = `case-${RUN}@example.test`;
    stubGateway({ ...PLAYER, email: email.toUpperCase() });
    const id = await mkCustomer(ws, email);
    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'backfill' })).toBe('linked');
  });

  it('skips erased, merged-away, already-linked and email-less contacts without calling the gateway', async () => {
    stubGateway(PLAYER);
    const survivor = await mkCustomer(ws, `surv-${RUN}@example.test`);
    const erased = await mkCustomer(ws, null, { erased_at: new Date() });
    const merged = await mkCustomer(ws, `merged-${RUN}@example.test`, { merged_into_customer_id: survivor });
    const linked = await mkCustomer(ws, `linked-${RUN}@example.test`, { maestro_user_id: 'already' });
    const noEmail = await mkCustomer(ws, null);

    for (const id of [erased, merged, linked, noEmail]) {
      expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'backfill' })).toBe('skipped');
    }
    expect(calls).toHaveLength(0);
    expect((await row(linked)).maestro_user_id).toBe('already');
  });

  it('no-ops for a workspace that is not a Maestro brand', async () => {
    stubGateway(PLAYER);
    const id = await mkCustomer(wsNoBrand, PLAYER.email);
    expect(await lib.linkCustomerToPlayer({ workspaceId: wsNoBrand, customerId: id, reason: 'inbound_email' })).toBe('no_brand');
    expect(calls).toHaveLength(0);
    expect((await row(id)).maestro_user_id).toBeNull();
  });

  it('a gateway error is reported as failed and NOT stamped, so the next email retries', async () => {
    stubGateway({ error: 'boom' }, 500);
    const id = await mkCustomer(ws, `outage-${RUN}@example.test`);
    expect(await lib.linkCustomerToPlayer({ workspaceId: ws, customerId: id, reason: 'inbound_email' })).toBe('failed');
    const r = await row(id);
    expect(r.maestro_user_id).toBeNull();
    expect(r.player_lookup_at).toBeNull();
  });

  it('applyPlayerToCustomer never touches an erased profile', async () => {
    const id = await mkCustomer(ws, null, { erased_at: new Date() });
    expect(await lib.applyPlayerToCustomer(sql, { workspaceId: ws, customerId: id, member: PLAYER })).toBe(false);
    expect((await row(id)).maestro_user_id).toBeNull();
  });

  it('backfill walks only brand workspaces, links what it can, and converges to remaining = 0', async () => {
    // Fresh candidates: everything above is linked or stamped, so it is out of
    // scope for the backfill by construction. Add three new ones.
    const email = `backfill-${RUN}@example.test`;
    stubGateway({ ...PLAYER, email });
    const a = await mkCustomer(ws, email);                              // will link
    const b = await mkCustomer(ws, `stranger-${RUN}@example.test`);     // mismatch → stamped
    const c = await mkCustomer(wsNoBrand, email);                       // not a brand workspace → ignored

    const first = await lib.runPlayerIdentityBackfillJob({ concurrency: 2 });
    // Other workspaces in a shared test DB may add to `workspaces`/`attempted`,
    // so assert on OUR rows and on convergence, not on absolute totals.
    expect(first.workspaces).toBeGreaterThanOrEqual(1);
    expect(first.attempted).toBeGreaterThanOrEqual(2);
    expect(first.failed).toBe(0);
    expect(first.remaining).toBe(0);
    expect((await row(a)).maestro_user_id).toBe(PLAYER.userId);
    expect((await row(b)).maestro_user_id).toBeNull();
    expect((await row(b)).player_lookup_at).not.toBeNull();
    expect((await row(c)).maestro_user_id).toBeNull();
    expect((await row(c)).player_lookup_at).toBeNull();

    // Idempotent: a second run has nothing left for OUR rows (other suites in
    // a shared DB may contribute candidates, so assert convergence + our rows).
    stubGateway({ ...PLAYER, email });
    const second = await lib.runPlayerIdentityBackfillJob();
    expect(second.remaining).toBe(0);
    expect((await row(b)).maestro_user_id).toBeNull();
  });
});
