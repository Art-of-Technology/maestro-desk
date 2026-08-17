// Self-serve sender domains — pure helpers (always) + the DB-backed security
// gates the feature introduced (RUN_DB_TESTS): unverified claims never route
// inbound mail, degraded domains fall out of the outbound From resolution,
// and send-time rejection degrades a domain exactly once.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

// env.ts validates process.env at import; provide hermetic fallbacks so the
// pure block runs without a real api/.env. `||=` keeps real values when set.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const { deriveStatus, DomainSchema } = await import('./lib/email-domains.js');

describe('deriveStatus', () => {
  it('maps verified_at/degraded_at to pending | verified | degraded', () => {
    expect(deriveStatus({ verified_at: null, degraded_at: null })).toBe('pending');
    // Never verified but degraded_at set (send-time degrade of an unverified
    // row is a no-op in practice, but the derivation stays pending-first).
    expect(deriveStatus({ verified_at: null, degraded_at: '2026-01-01' })).toBe('pending');
    expect(deriveStatus({ verified_at: '2026-01-01', degraded_at: null })).toBe('verified');
    expect(deriveStatus({ verified_at: '2026-01-01', degraded_at: '2026-01-02' })).toBe('degraded');
  });
});

describe('DomainSchema', () => {
  it('trims and lowercases (citext lookup determinism)', () => {
    expect(DomainSchema.parse('  Casino.Example.COM ')).toBe('casino.example.com');
  });
  it('rejects dotless and out-of-length strings', () => {
    expect(DomainSchema.safeParse('localhost').success).toBe(false);
    expect(DomainSchema.safeParse('a.b').success).toBe(true); // light by design — Postmark/DNS catch the rest
    expect(DomainSchema.safeParse('ab').success).toBe(false);
    expect(DomainSchema.safeParse('x'.repeat(254) + '.com').success).toBe(false);
  });
});

const runDbTests = process.env.RUN_DB_TESTS ? describe : describe.skip;

runDbTests('email domains (DB-backed)', () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
  let sql: ReturnType<typeof import('./lib/db.js').getDb>;
  let resolveInboundWorkspace: typeof import('./lib/inbound-email.js').resolveInboundWorkspace;
  let getOutboundFrom: typeof import('./lib/outbound-from.js').getOutboundFrom;
  let degradeDomainForSendRejection: typeof import('./lib/email-domains.js').degradeDomainForSendRejection;
  let addEmailDomain: typeof import('./lib/email-domains.js').addEmailDomain;
  let DomainConflictError: typeof import('./lib/email-domains.js').DomainConflictError;

  const RUN = Date.now();
  const ctx = {} as Record<string, string>;
  const dom = (label: string) => `${label}-${RUN}.ed.test`;

  beforeAll(async () => {
    app = (await import('./index.js')).default as typeof app;
    sql = (await import('./lib/db.js')).getDb();
    ({ resolveInboundWorkspace } = await import('./lib/inbound-email.js'));
    ({ getOutboundFrom } = await import('./lib/outbound-from.js'));
    ({ degradeDomainForSendRejection, addEmailDomain, DomainConflictError } = await import('./lib/email-domains.js'));

    const [{ provision_brand: ws }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${'ed-' + RUN}, ${'ed-' + RUN}) as provision_brand`;
    ctx.ws = ws;
    const [{ provision_brand: ws2 }] = await sql<{ provision_brand: string }[]>`
      select provision_brand(${'ed2-' + RUN}, ${'ed2-' + RUN}) as provision_brand`;
    ctx.ws2 = ws2;
  }, 30000);

  afterAll(async () => {
    await sql`delete from workspace_email_domains where workspace_id in (${ctx.ws}, ${ctx.ws2})`;
  });

  it('inbound routing ignores an UNVERIFIED domain claim (anti-squatting gate)', async () => {
    const d = dom('squat');
    await sql`insert into workspace_email_domains (workspace_id, domain) values (${ctx.ws}, ${d})`;

    const res = await resolveInboundWorkspace({ toDomain: d });
    expect(res.routed).toBe(false);            // fell through to the unrouted bucket
    expect(res.workspaceId).not.toBe(ctx.ws);  // the claimant never receives the mail

    // Verification flips routing on.
    await sql`update workspace_email_domains set verified_at = now() where workspace_id = ${ctx.ws} and domain = ${d}`;
    const verified = await resolveInboundWorkspace({ toDomain: d });
    expect(verified).toEqual({ workspaceId: ctx.ws, routed: true, matchedDomain: d });

    await sql`delete from workspace_email_domains where workspace_id = ${ctx.ws} and domain = ${d}`;
  });

  it('outbound From skips a degraded domain and resumes after recovery', async () => {
    const d = dom('from');
    await sql`insert into workspace_email_domains (workspace_id, domain, verified_at) values (${ctx.ws}, ${d}, now())`;

    expect((await getOutboundFrom(ctx.ws))?.fromEmail).toBe(`support@${d}`);

    await sql`update workspace_email_domains set degraded_at = now() where workspace_id = ${ctx.ws} and domain = ${d}`;
    expect(await getOutboundFrom(ctx.ws)).toBeNull(); // caller falls back to the platform sender

    await sql`update workspace_email_domains set degraded_at = null where workspace_id = ${ctx.ws} and domain = ${d}`;
    expect((await getOutboundFrom(ctx.ws))?.fromEmail).toBe(`support@${d}`);

    await sql`delete from workspace_email_domains where workspace_id = ${ctx.ws} and domain = ${d}`;
  });

  it('degradeDomainForSendRejection stamps once and never overwrites the first reason', async () => {
    const d = dom('rej');
    await sql`insert into workspace_email_domains (workspace_id, domain, verified_at) values (${ctx.ws}, ${d}, now())`;

    await degradeDomainForSendRejection(ctx.ws, d, 'send_rejected:400');
    // postgres.js parses timestamptz to Date — compare by epoch, not identity.
    const [first] = await sql<{ degraded_at: Date; degraded_reason: string }[]>`
      select degraded_at, degraded_reason from workspace_email_domains where workspace_id = ${ctx.ws} and domain = ${d}`;
    expect(first.degraded_reason).toBe('send_rejected:400');

    await degradeDomainForSendRejection(ctx.ws, d, 'send_rejected:401');
    const [second] = await sql<{ degraded_at: Date; degraded_reason: string }[]>`
      select degraded_at, degraded_reason from workspace_email_domains where workspace_id = ${ctx.ws} and domain = ${d}`;
    expect(second.degraded_at.getTime()).toBe(first.degraded_at.getTime());
    expect(second.degraded_reason).toBe('send_rejected:400');

    await sql`delete from workspace_email_domains where workspace_id = ${ctx.ws} and domain = ${d}`;
  });

  it('a STALE (7d+) unverified claim is superseded by another workspace\'s add', async () => {
    const d = dom('stale');
    const [claim] = await sql<{ id: string }[]>`
      insert into workspace_email_domains (workspace_id, domain, created_at)
      values (${ctx.ws}, ${d}, now() - interval '8 days') returning id`;

    const result = await addEmailDomain(ctx.ws2, d);
    expect(result.row.workspace_id).toBe(ctx.ws2);
    expect(result.superseded).toEqual({ workspaceId: ctx.ws, domainId: claim.id });

    // The squatter's claim is soft-deleted, not just shadowed.
    const [old] = await sql<{ deleted_at: Date | null }[]>`
      select deleted_at from workspace_email_domains where id = ${claim.id}`;
    expect(old.deleted_at).not.toBeNull();

    await sql`delete from workspace_email_domains where domain = ${d}`;
  });

  it('a FRESH unverified claim is protected (no supersede) — add conflicts', async () => {
    const d = dom('fresh');
    await sql`insert into workspace_email_domains (workspace_id, domain) values (${ctx.ws}, ${d})`;
    await expect(addEmailDomain(ctx.ws2, d)).rejects.toBeInstanceOf(DomainConflictError);
    await sql`delete from workspace_email_domains where domain = ${d}`;
  });

  it('a VERIFIED claim is never superseded, regardless of age', async () => {
    const d = dom('owned');
    await sql`
      insert into workspace_email_domains (workspace_id, domain, verified_at, created_at)
      values (${ctx.ws}, ${d}, now(), now() - interval '90 days')`;
    await expect(addEmailDomain(ctx.ws2, d)).rejects.toBeInstanceOf(DomainConflictError);
    await sql`delete from workspace_email_domains where domain = ${d}`;
  });

  it('workspace routes are mounted and require auth', async () => {
    const res = await app.request('/api/v1/email-domains');
    expect(res.status).toBe(401);
  });
});
