// What buildPlayerContext is allowed to put in an LLM prompt.
//
// This block is the only place live player account data reaches the model, and
// two fields are deliberately absent from it: KYC (removed from the product in
// Phase 4) and AML risk level (a higher-tier compliance signal, withheld pending
// a data-handling sign-off). Both were enforced by comment alone, so nothing
// stopped a future edit from pushing either back into `lines` — the failure would
// be silent, and visible only in prompts already sent.
//
// DB-free: global fetch is stubbed, nothing touches Postgres or the network.
// MAESTRO_API_TOKEN comes from test-setup.ts (the bun preload), so
// workerMaestroConfigured() is true here.

import { afterEach, describe, expect, it } from 'bun:test';
import { buildPlayerContext } from './player-context.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub the gateway's member-lookup response. */
function stubMember(member: Record<string, unknown>) {
  // Cast through unknown: the stub only needs to be callable, not to carry
  // fetch's static members (preconnect).
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(member), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const FULL_MEMBER = {
  success: true,
  userId: 'u-1',
  vipLevel: 'gold',
  balance: 120.5,
  balanceCy: 'EUR',
  country: 'MT',
  kycStatus: 'verified',
  kyc: 'verified',
  attributes: { amlRiskLevel: '3', kycStatus: 'verified' },
};

describe('buildPlayerContext prompt contents', () => {
  it('includes the fields the prompt is allowed to carry', async () => {
    stubMember(FULL_MEMBER);
    const ctx = await buildPlayerContext({ email: 'jane@x.test', brandId: 'b-1' });
    expect(ctx).toContain('VIP level: gold');
    expect(ctx).toContain('Balance: 120.5 EUR');
    expect(ctx).toContain('Country: MT');
  });

  it('never mentions KYC, in any spelling or nesting', async () => {
    stubMember(FULL_MEMBER);
    const ctx = await buildPlayerContext({ email: 'jane@x.test', brandId: 'b-1' });
    expect(ctx).not.toMatch(/kyc/i);
    expect(ctx).not.toMatch(/verified/i);
  });

  it('never mentions AML risk level — withheld pending data-handling sign-off', async () => {
    stubMember(FULL_MEMBER);
    const ctx = await buildPlayerContext({ email: 'jane@x.test', brandId: 'b-1' });
    expect(ctx).not.toMatch(/aml/i);
    expect(ctx).not.toMatch(/risk/i);
  });

  it('returns null when the only fields present are withheld ones', async () => {
    // A member carrying nothing but KYC and AML must produce NO prompt block at
    // all, rather than an empty "PLAYER CONTEXT" header inviting the model to
    // speculate about what is missing.
    stubMember({ success: true, userId: 'u-1', kycStatus: 'verified', attributes: { amlRiskLevel: '3' } });
    expect(await buildPlayerContext({ email: 'jane@x.test', brandId: 'b-1' })).toBeNull();
  });

  it('treats the gateway not-found sentinel as no data', async () => {
    // The gateway answers HTTP 200 with { success:false, errorCode:101 }.
    stubMember({ success: false, errorCode: 101 });
    expect(await buildPlayerContext({ email: 'nobody@x.test', brandId: 'b-1' })).toBeNull();
  });

  it('does not call the gateway without a lookup key', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await buildPlayerContext({ email: null, username: null })).toBeNull();
    expect(called).toBe(false);
  });
});
