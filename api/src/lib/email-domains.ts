// Sender-domain orchestration shared by the god panel and the workspace
// self-serve routes. Adding a domain is a two-system operation: a local
// workspace_email_domains row AND a Postmark Domains API registration that
// yields the DKIM + Return-Path DNS records the brand must publish. The
// check path re-verifies with Postmark, stamps verified_at exactly once
// (first full verification; never un-stamped), and tracks post-verification
// health in degraded_at (see 20260727120000_email_domain_health.sql).
//
// Extracted from routes/god.ts so the workspace routes don't duplicate the
// Postmark handling; the god handlers are thin wrappers with their original
// response shapes.

import { z } from 'zod';
import { getDb } from './db.js';
import {
  createDomain as pmCreateDomain,
  getDomain as pmGetDomain,
  verifyDomain as pmVerifyDomain,
  deleteDomain as pmDeleteDomain,
  findDomainByName as pmFindDomainByName,
  isFullyVerified,
  dnsRecommendations,
  isPostmarkAccountConfigured,
  PostmarkAccountError,
  type PostmarkDomain,
  type DnsRecommendations,
} from './postmark-domains.js';
import { sendOpsAlert } from './alert.js';

// Domain validation is light — any string with at least one dot. Postmark +
// DNS verification catch invalid domains later. Lowercased so the lookup
// against citext is fully deterministic. (Moved from routes/god.ts.)
export const DomainSchema = z
  .string()
  .min(3)
  .max(253)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => s.includes('.'), 'domain must contain a dot');

export interface EmailDomainRow {
  id: string;
  workspace_id: string;
  domain: string;
  verified_at: string | null;
  degraded_at: string | null;
  degraded_reason: string | null;
  last_checked_at: string | null;
  postmark_domain_id: string | null;
  dns_records: DnsRecommendations | null;
  created_at: string;
}

export type EmailDomainStatus = 'pending' | 'verified' | 'degraded';

export function deriveStatus(row: Pick<EmailDomainRow, 'verified_at' | 'degraded_at'>): EmailDomainStatus {
  if (!row.verified_at) return 'pending';
  if (row.degraded_at) return 'degraded';
  return 'verified';
}

// Thrown on a duplicate domain (partial unique on (domain) where deleted_at
// is null — GLOBAL across workspaces, since inbound routing keys on it).
export class DomainConflictError extends Error {
  constructor(domain: string) {
    super(`Domain ${domain} is already in use`);
  }
}

// Create at Postmark, or ADOPT the account's existing domain of that name —
// a failed Postmark delete (removeEmailDomain is best-effort) or a legacy
// orphan would otherwise make pmCreateDomain fail "already added" forever.
async function createOrAdoptDomain(domain: string): Promise<PostmarkDomain> {
  try {
    return await pmCreateDomain(domain);
  } catch (err) {
    const existing = await pmFindDomainByName(domain).catch(() => null);
    if (existing) return existing;
    throw err;
  }
}

export async function listEmailDomains(workspaceId: string): Promise<EmailDomainRow[]> {
  const sql = getDb();
  return sql<EmailDomainRow[]>`
    select id, workspace_id, domain, verified_at, degraded_at, degraded_reason,
           last_checked_at, postmark_domain_id, dns_records, created_at
    from workspace_email_domains
    where workspace_id = ${workspaceId} and deleted_at is null
    order by created_at asc
  `;
}

export interface AddEmailDomainResult {
  row: EmailDomainRow;
  dnsSetup: DnsRecommendations | null;
  postmarkError: string | null;
  // Set when this add reclaimed the domain from another workspace's STALE
  // unverified claim (soft-deleted here) — callers audit it.
  superseded: { workspaceId: string; domainId: string } | null;
}

// Insert the local row, then best-effort provision at Postmark (the local
// row survives a Postmark outage; the check path acts as the recovery hook).
export async function addEmailDomain(workspaceId: string, domain: string): Promise<AddEmailDomainResult> {
  const sql = getDb();

  // Verified-reclaim: a claim that sat unverified for 7+ days is not the DNS
  // owner (publishing the records takes minutes), so it must not lock the
  // real owner out until the 30-day expiry. Fresh claims keep a protected
  // window to finish verification, which also blocks supersede ping-pong —
  // and only the actual DNS owner can ever verify. Verified claims are
  // never superseded.
  let superseded: AddEmailDomainResult['superseded'] = null;
  const [holder] = await sql<{ id: string; workspace_id: string; stale: boolean }[]>`
    select id, workspace_id,
           (verified_at is null and created_at < now() - interval '7 days') as stale
    from workspace_email_domains
    where domain = ${domain} and deleted_at is null
  `;
  if (holder && holder.stale && holder.workspace_id !== workspaceId) {
    const removed = await removeEmailDomain(holder.workspace_id, holder.id);
    if (removed) superseded = { workspaceId: holder.workspace_id, domainId: holder.id };
  }

  let row: EmailDomainRow;
  try {
    const inserted = await sql<EmailDomainRow[]>`
      insert into workspace_email_domains (workspace_id, domain)
      values (${workspaceId}, ${domain})
      returning id, workspace_id, domain, verified_at, degraded_at, degraded_reason,
                last_checked_at, postmark_domain_id, dns_records, created_at
    `;
    row = inserted[0];
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') throw new DomainConflictError(domain);
    throw err;
  }

  let pmDomain: PostmarkDomain | null = null;
  let postmarkError: string | null = null;
  if (isPostmarkAccountConfigured()) {
    try {
      pmDomain = await createOrAdoptDomain(domain);
    } catch (err) {
      postmarkError = err instanceof Error ? err.message : String(err);
      console.error(`[email-domains] Postmark createDomain failed for ${domain}: ${postmarkError}`);
    }
    if (pmDomain) {
      const dnsSetup = dnsRecommendations(pmDomain);
      try {
        await sql`
          update workspace_email_domains
          set postmark_domain_id = ${String(pmDomain.ID)}, dns_records = ${sql.json(dnsSetup as never)}
          where id = ${row.id}
        `;
        row = { ...row, postmark_domain_id: String(pmDomain.ID), dns_records: dnsSetup };
      } catch (err) {
        console.error('[email-domains] postmark_domain_id update failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  return {
    row,
    dnsSetup: pmDomain ? dnsRecommendations(pmDomain) : null,
    postmarkError,
    superseded,
  };
}

export interface CheckEmailDomainResult {
  row: EmailDomainRow;
  pmDomain: PostmarkDomain;
  fullyVerified: boolean;
  becameVerified: boolean;
  becameDegraded: boolean;
  recovered: boolean;
  dnsSetup: DnsRecommendations;
}

// Re-check verification with Postmark and reconcile local state. Throws
// PostmarkAccountNotConfiguredError / PostmarkAccountError for the caller to
// map to 503/502. `readOnly` uses getDomain instead of triggering Postmark's
// DKIM/Return-Path DNS re-checks (used by the cron drift pass on healthy
// rows — Postmark keeps those flags current on its own schedule).
//
// `clearSendRejected`: a `send_rejected:*` degrade (account-level Postmark
// rejection) usually persists even while the DKIM/Return-Path DNS flags stay
// verified — auto-clearing it from the 45s poll or the cron would flap
// (clear → next send fails → re-degrade → critical alert, forever). So only
// DNS-lapse degrades auto-clear; send-rejection degrades clear solely on an
// explicit human action (workspace "Check now" button, god verify).
export async function checkEmailDomain(
  workspaceId: string,
  domainId: string,
  opts: { readOnly?: boolean; clearSendRejected?: boolean } = {},
): Promise<CheckEmailDomainResult | null> {
  const sql = getDb();

  const [row] = await sql<EmailDomainRow[]>`
    select id, workspace_id, domain, verified_at, degraded_at, degraded_reason,
           last_checked_at, postmark_domain_id, dns_records, created_at
    from workspace_email_domains
    where id = ${domainId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!row) return null;

  let pmDomain: PostmarkDomain;
  if (!row.postmark_domain_id) {
    // Postmark was down (or unconfigured) at add time — recovery path.
    pmDomain = await createOrAdoptDomain(row.domain);
    try {
      await sql`update workspace_email_domains set postmark_domain_id = ${String(pmDomain.ID)} where id = ${row.id}`;
      row.postmark_domain_id = String(pmDomain.ID);
    } catch (err) {
      console.error('[email-domains] postmark_domain_id update failed:', err instanceof Error ? err.message : err);
    }
  } else if (opts.readOnly) {
    pmDomain = await pmGetDomain(Number(row.postmark_domain_id));
  } else {
    pmDomain = await pmVerifyDomain(Number(row.postmark_domain_id));
  }

  const fullyVerified = isFullyVerified(pmDomain);
  const dnsSetup = dnsRecommendations(pmDomain);
  // DNS-lapse degrades auto-clear on re-verification; send_rejected degrades
  // stick until an explicit human check (see clearSendRejected above). The
  // reason predicate is evaluated IN SQL against the row's current state —
  // deciding from the pre-Postmark-round-trip read would clear a send
  // rejection that landed while the (slow) verify call was in flight.
  const mayClear = !!opts.clearSendRejected;

  // Reconcile in one statement. verified_at is stamped only on the FIRST
  // full verification; degraded_at is set when a verified domain's Postmark
  // flags lapse and cleared when they come back.
  await sql`
    update workspace_email_domains
    set last_checked_at = now(),
        dns_records = ${sql.json(dnsSetup as never)},
        verified_at = case when ${fullyVerified} and verified_at is null then now() else verified_at end,
        degraded_at = case
          when ${fullyVerified} and (${mayClear} or degraded_reason is null or degraded_reason like 'postmark_verification_lapsed%') then null
          when ${fullyVerified} then degraded_at
          when verified_at is not null and degraded_at is null then now()
          else degraded_at
        end,
        degraded_reason = case
          when ${fullyVerified} and (${mayClear} or degraded_reason is null or degraded_reason like 'postmark_verification_lapsed%') then null
          when ${fullyVerified} then degraded_reason
          when verified_at is not null and degraded_at is null then ${
            `postmark_verification_lapsed:dkim=${pmDomain.DKIMVerified}:return_path=${pmDomain.ReturnPathDomainVerified}`
          }
          else degraded_reason
        end
    where id = ${row.id}
  `;

  const [fresh] = await sql<EmailDomainRow[]>`
    select id, workspace_id, domain, verified_at, degraded_at, degraded_reason,
           last_checked_at, postmark_domain_id, dns_records, created_at
    from workspace_email_domains where id = ${row.id}
  `;

  // Transition flags from the pre-read vs the post-update row, so they
  // report what the reconcile actually DID (not what the stale read implied).
  const post = fresh ?? row;
  const becameVerified = !row.verified_at && !!post.verified_at;
  const becameDegraded = !row.degraded_at && !!post.degraded_at;
  const recovered = !!row.degraded_at && !post.degraded_at;

  return { row: post, pmDomain, fullyVerified, becameVerified, becameDegraded, recovered, dnsSetup };
}

export interface RemoveEmailDomainResult {
  row: Pick<EmailDomainRow, 'id' | 'domain' | 'postmark_domain_id'>;
  postmarkDeleteError: string | null;
}

// Best-effort Postmark delete (404 there = already gone), then local
// soft-delete — the partial unique index frees the domain string for reuse.
export async function removeEmailDomain(workspaceId: string, domainId: string): Promise<RemoveEmailDomainResult | null> {
  const sql = getDb();

  const [row] = await sql<{ id: string; domain: string; postmark_domain_id: string | null }[]>`
    select id, domain, postmark_domain_id
    from workspace_email_domains
    where id = ${domainId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!row) return null;

  let postmarkDeleteError: string | null = null;
  if (row.postmark_domain_id && isPostmarkAccountConfigured()) {
    try {
      await pmDeleteDomain(Number(row.postmark_domain_id));
    } catch (err) {
      if (err instanceof PostmarkAccountError && err.httpStatus === 404) {
        // Already gone at Postmark — treat as success.
      } else {
        postmarkDeleteError = err instanceof Error ? err.message : String(err);
        console.error(`[email-domains] Postmark delete failed for ${row.domain}: ${postmarkDeleteError}`);
      }
    }
  }

  await sql`update workspace_email_domains set deleted_at = now() where id = ${row.id}`;

  return { row, postmarkDeleteError };
}

export interface SweepResult {
  pendingChecked: number;
  newlyVerified: number;
  verifiedChecked: number;
  newlyDegraded: number;
  recovered: number;
  expired: number;
}

// Daily cron sweep (piggybacked on /api/v1/cron/retention):
//   1. Pending rows -> full verify (auto-stamps owners who never revisit the
//      settings page after publishing DNS).
//   2. Verified rows -> read-only drift check; lapse => degraded + alert.
//      Already-degraded rows get a full verify (recovery attempt).
//   3. Unverified rows older than 30 days -> soft-delete (anti-squatting
//      hygiene; a slow brand can simply re-add).
// Per-row try/catch: one Postmark hiccup must not stop the sweep.
export async function sweepEmailDomains(): Promise<SweepResult> {
  const sql = getDb();
  const out: SweepResult = { pendingChecked: 0, newlyVerified: 0, verifiedChecked: 0, newlyDegraded: 0, recovered: 0, expired: 0 };
  if (!isPostmarkAccountConfigured()) return out;

  // least-recently-checked first (nulls = never checked) so a backlog beyond
  // the limit rotates across days instead of starving the newest rows.
  const rows = await sql<Pick<EmailDomainRow, 'id' | 'workspace_id' | 'domain' | 'verified_at' | 'degraded_at' | 'postmark_domain_id'>[]>`
    select id, workspace_id, domain, verified_at, degraded_at, postmark_domain_id, dns_records, created_at, last_checked_at, degraded_reason
    from workspace_email_domains
    where deleted_at is null and postmark_domain_id is not null
    order by last_checked_at asc nulls first, created_at asc
    limit 100
  `;

  for (const r of rows) {
    try {
      const healthyVerified = !!r.verified_at && !r.degraded_at;
      const result = await checkEmailDomain(r.workspace_id, r.id, { readOnly: healthyVerified });
      if (!result) continue;
      if (!r.verified_at) {
        out.pendingChecked++;
        if (result.becameVerified) out.newlyVerified++;
      } else {
        out.verifiedChecked++;
        if (result.becameDegraded) {
          out.newlyDegraded++;
          await sendOpsAlert({
            signature: `email-domain-drift:${r.workspace_id}:${r.domain}`,
            severity: 'critical',
            title: 'Sender domain verification lapsed — falling back to platform From',
            detail: `workspace=${r.workspace_id} domain=${r.domain} dkim=${result.pmDomain.DKIMVerified} return_path=${result.pmDomain.ReturnPathDomainVerified}. Brand DNS records no longer verify at Postmark.`,
          });
        }
        if (result.recovered) {
          out.recovered++;
          await sendOpsAlert({
            signature: `email-domain-recovered:${r.workspace_id}:${r.domain}`,
            severity: 'warning',
            title: 'Sender domain verification recovered',
            detail: `workspace=${r.workspace_id} domain=${r.domain} re-verified at Postmark; branded sending resumed.`,
          });
        }
      }
    } catch (err) {
      console.warn(`[email-domains] sweep check failed for ${r.domain}:`, err instanceof Error ? err.message : err);
    }
  }

  // Expire abandoned unverified claims. A never-verified row only blocks the
  // (globally unique) domain string — 30 days of not publishing DNS records
  // reads as abandoned or squatting. Routed through removeEmailDomain so the
  // Postmark-side domain is deleted too: a soft-delete alone would orphan it
  // under the platform account, and a later re-add of the same domain would
  // then fail pmCreateDomain ("already added") forever.
  // Bounded like the check pass: each expiry is a Postmark round-trip, and
  // the sweep runs daily — any backlog beyond the cap drains across days.
  const expireCandidates = await sql<{ id: string; workspace_id: string; domain: string }[]>`
    select id, workspace_id, domain
    from workspace_email_domains
    where deleted_at is null and verified_at is null and created_at < now() - interval '30 days'
    order by created_at asc
    limit 100
  `;
  for (const r of expireCandidates) {
    try {
      const removed = await removeEmailDomain(r.workspace_id, r.id);
      if (removed) out.expired++;
    } catch (err) {
      console.warn(`[email-domains] sweep expiry failed for ${r.domain}:`, err instanceof Error ? err.message : err);
    }
  }

  return out;
}

// Best-effort degrade used by the send-time fallback (send-branded-email.ts):
// a rejected branded From means subsequent sends should resolve straight to
// the platform sender rather than re-failing per email.
export async function degradeDomainForSendRejection(workspaceId: string, domain: string, reason: string): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      update workspace_email_domains
      set degraded_at = coalesce(degraded_at, now()),
          degraded_reason = coalesce(degraded_reason, ${reason})
      where workspace_id = ${workspaceId} and domain = ${domain} and deleted_at is null
    `;
  } catch (err) {
    console.warn('[email-domains] degrade-on-rejection failed:', err instanceof Error ? err.message : err);
  }
}
