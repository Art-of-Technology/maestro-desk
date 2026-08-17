// dnsRecommendations must surface a publishable DKIM record for a NEW domain:
// Postmark keeps it in the DKIMPending* pair until first verification (the
// non-Pending pair is empty strings). Selection is atomic per pair — mixing a
// pending host with the verified key's value yields a record that can never
// verify — and pending is used only while DKIM is unverified (a verified
// domain's snapshot must keep matching the live DNS; no UI renders a
// rotation state yet).

import { describe, expect, it } from 'bun:test';
import { dnsRecommendations, type PostmarkDomain } from './lib/postmark-domains.js';

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

  it('uses the verified pair when nothing is pending', () => {
    const { dkim } = dnsRecommendations({
      ...base,
      DKIMVerified: true,
      DKIMHost: '20260101._domainkey',
      DKIMTextValue: 'k=rsa; p=ACTIVEKEY',
    });
    expect(dkim.host).toBe('20260101._domainkey');
    expect(dkim.value).toBe('k=rsa; p=ACTIVEKEY');
  });

  it('keeps the verified pair on a verified domain even when a rotation is pending', () => {
    const { dkim } = dnsRecommendations({
      ...base,
      DKIMVerified: true,
      DKIMHost: '20260101._domainkey',
      DKIMTextValue: 'k=rsa; p=ACTIVEKEY',
      DKIMPendingHost: '20260817._domainkey',
      DKIMPendingTextValue: 'k=rsa; p=NEWKEY',
    });
    expect(dkim.host).toBe('20260101._domainkey');
    expect(dkim.value).toBe('k=rsa; p=ACTIVEKEY');
  });

  it('never mixes pairs: a half-populated pending pair falls back whole', () => {
    const { dkim } = dnsRecommendations({
      ...base,
      DKIMHost: '20260101._domainkey',
      DKIMTextValue: 'k=rsa; p=LAPSEDKEY',
      DKIMPendingHost: '20260817._domainkey',
      DKIMPendingTextValue: '', // key not minted yet / degraded payload
    });
    expect(dkim.host).toBe('20260101._domainkey');
    expect(dkim.value).toBe('k=rsa; p=LAPSEDKEY');
  });

  it('emits empty host/value when neither pair is populated (UI renders a not-issued hint)', () => {
    const { dkim } = dnsRecommendations(base);
    expect(dkim.host).toBe('');
    expect(dkim.value).toBe('');
  });
});
