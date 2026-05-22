import { env } from './env.ts';

// ─── Postmark Domains API ────────────────────────────────────────────────
//
// Domain-level DKIM + Return-Path verification. Once a brand verifies their
// domain (acme.com), ANY sender on that domain (support@, billing@, …) can
// send via Postmark with proper authentication. This is the right primitive
// for white-label — verify once, send from anything.
//
// API base:    https://api.postmarkapp.com
// Auth header: X-Postmark-Account-Token (NOT X-Postmark-Server-Token —
//              Domains/Senders are account-level resources, not per-server)
// Docs:        https://postmarkapp.com/developer/api/domains-api
//
// Endpoints used:
//   POST   /domains                          create
//   GET    /domains/:id                      get (includes DNS records + verification state)
//   PUT    /domains/:id/verifyDkim           trigger DKIM check against DNS
//   PUT    /domains/:id/verifyReturnPath     trigger Return-Path check against DNS
//   DELETE /domains/:id                      delete (offboard a brand)
//
// Verification is two-step from the brand's perspective:
//   1. We POST /domains → returns DNS records (DKIM TXT + Return-Path CNAME).
//   2. Brand pastes those records into their DNS.
//   3. Brand (or god UI) hits our verify endpoint → we PUT verifyDkim +
//      verifyReturnPath → Postmark queries DNS → returns updated flags.

const ENDPOINT = 'https://api.postmarkapp.com';

// Postmark Domain object shape — subset of fields we care about. The full
// response also includes DKIMPendingHost/TextValue, etc. for key-rotation
// flows; we ignore those for v1.
export interface PostmarkDomain {
  ID: number;
  Name: string;
  // DKIM
  DKIMVerified: boolean;
  DKIMHost: string;          // e.g. "20231115._domainkey"
  DKIMTextValue: string;     // the long TXT record value
  // Return-Path
  ReturnPathDomain: string;        // e.g. "pm-bounces.acme.com"
  ReturnPathDomainVerified: boolean;
  ReturnPathDomainCNAMEValue: string;  // e.g. "pm.mtasv.net"
}

export class PostmarkAccountError extends Error {
  constructor(message: string, public httpStatus: number, public code?: number) {
    super(message);
  }
}

export class PostmarkAccountNotConfiguredError extends Error {
  constructor() {
    super('Postmark Domains API is not configured (POSTMARK_ACCOUNT_TOKEN is empty)');
  }
}

export function isPostmarkAccountConfigured(): boolean {
  return Boolean(env.POSTMARK_ACCOUNT_TOKEN);
}

async function pmFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!isPostmarkAccountConfigured()) {
    throw new PostmarkAccountNotConfiguredError();
  }
  const res = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: {
      'X-Postmark-Account-Token': env.POSTMARK_ACCOUNT_TOKEN,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { Message?: string; ErrorCode?: number };
  if (!res.ok) {
    throw new PostmarkAccountError(
      `Postmark Domains API ${res.status}: ${body.Message ?? res.statusText}`,
      res.status,
      body.ErrorCode,
    );
  }
  return body;
}

/** Create a domain. Postmark returns DNS records for the brand to set up. */
export async function createDomain(name: string): Promise<PostmarkDomain> {
  return (await pmFetch('/domains', {
    method: 'POST',
    body: JSON.stringify({ Name: name }),
  })) as PostmarkDomain;
}

/** Fetch current state (DNS records + verification flags). */
export async function getDomain(id: number): Promise<PostmarkDomain> {
  return (await pmFetch(`/domains/${id}`)) as PostmarkDomain;
}

/**
 * Trigger DNS verification for both DKIM and Return-Path. Postmark queries
 * the brand's DNS; the returned object reflects the post-check state. Run
 * in sequence (not parallel) — both calls hit the same domain object and
 * Postmark's API can race if they overlap.
 */
export async function verifyDomain(id: number): Promise<PostmarkDomain> {
  await pmFetch(`/domains/${id}/verifyDkim`, { method: 'PUT' });
  return (await pmFetch(`/domains/${id}/verifyReturnPath`, { method: 'PUT' })) as PostmarkDomain;
}

/** Delete the domain at Postmark. Used when a brand offboards. */
export async function deleteDomain(id: number): Promise<void> {
  await pmFetch(`/domains/${id}`, { method: 'DELETE' });
}

/** A domain is "fully verified" only when BOTH DKIM and Return-Path resolve. */
export function isFullyVerified(d: PostmarkDomain): boolean {
  return d.DKIMVerified && d.ReturnPathDomainVerified;
}

// ─── DNS recommendations ─────────────────────────────────────────────────
//
// Returns the full set of DNS records a brand owner should add to their
// domain for both authentication (DKIM, Return-Path — Postmark verifies
// these) and best-practice deliverability (SPF, DMARC — Postmark doesn't
// verify these but receiving providers heavily weight them).
//
// Why all four matter for inbox placement:
//   - DKIM signs each outbound message; receivers re-verify the signature
//     against the published TXT record. Missing/invalid DKIM is the single
//     biggest junk-folder trigger.
//   - Return-Path lets Postmark process bounces. Required for SPF alignment
//     (the envelope-from must be on a domain the brand controls).
//   - SPF authorizes Postmark's sending IPs. Gmail and Outlook treat SPF
//     misalignment as a strong spam signal.
//   - DMARC ties SPF + DKIM together with a policy. Recommended even with
//     p=none (monitoring) — providers like Gmail are starting to require it.
//
// SPF + DMARC are static templates (same value for every domain Postmark
// hosts) so they're hardcoded here. DKIM + Return-Path come from Postmark's
// per-domain provisioning response.

export interface DnsRecommendation {
  type: 'TXT' | 'CNAME';
  host: string;
  value: string;
  priority: 'required' | 'recommended';
  why: string;
}

export interface DnsRecommendations {
  dkim:        DnsRecommendation;
  return_path: DnsRecommendation;
  spf:         DnsRecommendation;
  dmarc:       DnsRecommendation;
}

export function dnsRecommendations(d: PostmarkDomain): DnsRecommendations {
  return {
    dkim: {
      type: 'TXT',
      host: d.DKIMHost,
      value: d.DKIMTextValue,
      priority: 'required',
      why: 'Cryptographically signs outbound mail so receivers can verify it came from your domain. Missing DKIM is the biggest single junk-folder trigger.',
    },
    return_path: {
      type: 'CNAME',
      host: d.ReturnPathDomain,
      value: d.ReturnPathDomainCNAMEValue,
      priority: 'required',
      why: 'Routes bounce notifications to Postmark and provides SPF alignment with the From address. Required.',
    },
    spf: {
      type: 'TXT',
      host: d.Name,
      // Postmark's published SPF include. ~all = softfail (mail still
      // accepted but flagged). Switch to -all only after watching DMARC
      // reports confirm no legitimate mail is unauthenticated.
      value: 'v=spf1 a mx include:spf.mtasv.net ~all',
      priority: 'recommended',
      why: 'Authorizes Postmark to send on behalf of your domain. Gmail and Outlook weight SPF heavily for inbox placement.',
    },
    dmarc: {
      type: 'TXT',
      host: `_dmarc.${d.Name}`,
      // p=none (monitoring) is the safe starting policy — receivers report
      // but don't quarantine. Tighten to p=quarantine or p=reject once the
      // brand has watched DMARC reports for ~2 weeks and confirmed no
      // legitimate mail is misaligned. rua=mailto:rua@dmarc.postmarkapp.com
      // sends aggregate reports to Postmark's free DMARC monitoring.
      value: 'v=DMARC1; p=none; pct=100; rua=mailto:rua@dmarc.postmarkapp.com',
      priority: 'recommended',
      why: 'Tells receivers what to do with mail that fails SPF/DKIM and where to send reports. Start with p=none (monitoring), tighten after watching reports.',
    },
  };
}
