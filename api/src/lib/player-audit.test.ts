import { describe, expect, it } from 'bun:test';
import { summarizePlayerAccess } from './player-audit.js';

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
      userId: 'u-1', balance: 120.5, balanceCy: 'EUR', kycStatus: 'verified',
      vipLevel: 'gold', email: 'jane@x.test', country: 'MT',
    });
    expect(a.accessed.sort()).toEqual(['balance', 'contact', 'kyc', 'vip']);
  });

  it('omits categories that are absent or blank', () => {
    expect(summarizePlayerAccess({ userId: 'u-1' }).accessed).toEqual([]);
    // whitespace-only strings are treated as absent by str()
    expect(summarizePlayerAccess({ userId: 'u-1', kycStatus: '   ' }).accessed).toEqual([]);
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
});
