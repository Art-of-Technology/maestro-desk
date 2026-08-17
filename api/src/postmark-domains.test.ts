// dnsRecommendations must surface a publishable DKIM record for a NEW domain:
// Postmark keeps it in the DKIMPending* pair until first verification (the
// non-Pending pair is empty strings), so pending wins whenever present.

import { describe, expect, it } from 'bun:test';

// env.ts validates process.env at import; provide hermetic fallbacks so the
// pure block runs without a real api/.env. `||=` keeps real values when set.
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=require';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';

const { dnsRecommendations } = await import('./lib/postmark-domains.js');
type PostmarkDomain = import('./lib/postmark-domains.js').PostmarkDomain;

const base: PostmarkDomain = {
  ID: 1,
  Name: 'casino.example.com',
  DKIMVerified: false,
  DKIMHost: '',
  DKIMTextValue: '',
  DKIMPendingHost: '',
  DKIMPendingTextValue: '',
  ReturnPathDomain: 'pm-bounces.casino.example.com',
  ReturnPathDomainVerified: false,
  ReturnPathDomainCNAMEValue: 'pm.mtasv.net',
};

describe('dnsRecommendations DKIM', () => {
  it('uses the pending pair for a new (unverified) domain', () => {
    const { dkim } = dnsRecommendations({
      ...base,
      DKIMPendingHost: '20260817._domainkey',
      DKIMPendingTextValue: 'k=rsa; p=PENDINGKEY',
    });
    expect(dkim.host).toBe('20260817._domainkey');
    expect(dkim.value).toBe('k=rsa; p=PENDINGKEY');
  });

  it('falls back to the verified pair when nothing is pending', () => {
    const { dkim } = dnsRecommendations({
      ...base,
      DKIMVerified: true,
      DKIMHost: '20260101._domainkey',
      DKIMTextValue: 'k=rsa; p=ACTIVEKEY',
    });
    expect(dkim.host).toBe('20260101._domainkey');
    expect(dkim.value).toBe('k=rsa; p=ACTIVEKEY');
  });

  it('prefers the pending key during a rotation (both pairs set)', () => {
    const { dkim } = dnsRecommendations({
      ...base,
      DKIMVerified: true,
      DKIMHost: '20260101._domainkey',
      DKIMTextValue: 'k=rsa; p=ACTIVEKEY',
      DKIMPendingHost: '20260817._domainkey',
      DKIMPendingTextValue: 'k=rsa; p=NEWKEY',
    });
    expect(dkim.host).toBe('20260817._domainkey');
    expect(dkim.value).toBe('k=rsa; p=NEWKEY');
  });
});
