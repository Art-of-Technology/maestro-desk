import { describe, expect, it } from 'bun:test';
import { summarizePlayerAccess, stripRemovedPlayerFields } from './player-audit.js';

describe('summarizePlayerAccess', () => {
  it('prefers userId, falls back to memberId, else null', () => {
    expect(summarizePlayerAccess({ userId: 'u-1', memberId: 7 }).playerId).toBe('u-1');
    expect(summarizePlayerAccess({ memberId: 7 }).playerId).toBe('7');
    expect(summarizePlayerAccess({ username: 'jane' }).playerId).toBeNull();
  });

  it('uses the supplied fallback id when the record has no userId/memberId', () => {
    expect(summarizePlayerAccess({ username: 'jane' }, 'jane@x.test').playerId).toBe('jane@x.test');
    // a real id still wins over the fallback
    expect(summarizePlayerAccess({ userId: 'u-1' }, 'jane@x.test').playerId).toBe('u-1');
  });

  it('reports the sensitive categories present', () => {
    const a = summarizePlayerAccess({
      userId: 'u-1', balance: 120.5, balanceCy: 'EUR',
      vipLevel: 'gold', email: 'jane@x.test', country: 'MT',
    });
    expect(a.accessed.sort()).toEqual(['balance', 'contact', 'vip']);
  });

  it('omits categories that are absent or blank', () => {
    expect(summarizePlayerAccess({ userId: 'u-1' }).accessed).toEqual([]);
    // whitespace-only strings are treated as absent by str()
    expect(summarizePlayerAccess({ userId: 'u-1', vipLevel: '   ' }).accessed).toEqual([]);
  });

  it('detects balance from currency alone, and contact from mobile alone', () => {
    expect(summarizePlayerAccess({ userId: 'u', balanceCy: 'EUR' }).accessed).toContain('balance');
    expect(summarizePlayerAccess({ userId: 'u', mobile: '+15551234' }).accessed).toContain('contact');
  });

  it('never returns the underlying values — only categories + id', () => {
    const a = summarizePlayerAccess({ userId: 'u-1', balance: 999, email: 'secret@x.test' });
    const serialized = JSON.stringify(a);
    expect(serialized).not.toContain('999');
    expect(serialized).not.toContain('secret@x.test');
  });

  it('does not report a kyc category — KYC was removed from the product', () => {
    const a = summarizePlayerAccess({ userId: 'u-1', kycStatus: 'verified', kyc: 'verified' });
    expect(a.accessed).not.toContain('kyc');
    expect(a.accessed).toEqual([]);
  });
});

// This suite is the gate behind "we removed KYC". Without it, the only thing
// stopping the gateway's value from reaching an agent's browser is the SPA
// choosing not to render it — and a disclosed value that no longer appears in
// the read-access categories makes the audit trail understate what was seen.
describe('stripRemovedPlayerFields', () => {
  it('removes both KYC spellings, top level and nested under attributes', () => {
    const member: Record<string, unknown> = {
      userId: 'u-1',
      kycStatus: 'verified',
      kyc: 'pending',
      attributes: { kycStatus: 'verified', kyc: 'pending', amlRiskLevel: '3' },
    };
    stripRemovedPlayerFields(member);
    expect(JSON.stringify(member)).not.toMatch(/kyc/i);
  });

  it('leaves everything else untouched, including the AML level', () => {
    const member: Record<string, unknown> = {
      userId: 'u-1', balance: 120.5, vipLevel: 'gold', kycStatus: 'verified',
      attributes: { amlRiskLevel: '3' },
    };
    stripRemovedPlayerFields(member);
    expect(member).toEqual({
      userId: 'u-1', balance: 120.5, vipLevel: 'gold',
      attributes: { amlRiskLevel: '3' },
    });
  });

  it('tolerates a missing or non-object attributes bag', () => {
    expect(() => stripRemovedPlayerFields({ userId: 'u' })).not.toThrow();
    expect(() => stripRemovedPlayerFields({ userId: 'u', attributes: null })).not.toThrow();
    expect(() => stripRemovedPlayerFields({ userId: 'u', attributes: 'nope' })).not.toThrow();
  });
});
