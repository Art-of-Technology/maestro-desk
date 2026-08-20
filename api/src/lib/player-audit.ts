// Summarise a player-data view for the read-access audit trail.
//
// Regulators expect a "who looked at this account" record. We log the stable
// player identifier + which CATEGORIES of sensitive data were exposed — never
// the values themselves (the audit log must not become a second copy of the
// player's PII).

import { str } from './maestro.js';

// Field names the gateway may return that Respovia no longer surfaces anywhere,
// and so must not disclose. Phase 4 removed KYC from the product; the gateway
// still sends it. Both spellings are listed because the code this replaced
// probed `kycStatus` and bare `kyc`, and `attributes` is where the gateway puts
// compliance fields.
const REMOVED_FIELDS = ['kycStatus', 'kyc'] as const;

/**
 * Strip fields the product no longer surfaces from a gateway member record,
 * IN PLACE, before it is audited or returned to a client.
 *
 * This exists so "we removed KYC" is enforced at the API boundary rather than by
 * the SPA choosing not to render it: a value that still crossed the wire would be
 * disclosed (and visible in devtools) while no longer appearing in the
 * read-access categories, so the audit trail would understate what was seen.
 * Call this BEFORE summarizePlayerAccess so the two cannot disagree.
 */
export function stripRemovedPlayerFields(member: Record<string, unknown>): Record<string, unknown> {
  for (const f of REMOVED_FIELDS) delete member[f];
  const attrs = member.attributes;
  if (attrs && typeof attrs === 'object') {
    for (const f of REMOVED_FIELDS) delete (attrs as Record<string, unknown>)[f];
  }
  return member;
}

// The exact category strings written to the audit trail. Exported so downstream
// consumers (reporting, the append-only hardening, regulator tooling) share one
// contract and typos can't drift in.
// NOTE: historic audit rows still carry 'kyc' (dropped in Phase 4) — this union
// is the set written from now on, never a closed set for reading history back.
export const PLAYER_ACCESS_CATEGORIES = ['balance', 'vip', 'contact'] as const;
export type PlayerAccessCategory = (typeof PLAYER_ACCESS_CATEGORIES)[number];

export interface PlayerAccessSummary {
  // Stable Maestro identifier for the viewed player (never their email).
  playerId: string | null;
  // Sensitive data categories present in the returned record.
  accessed: PlayerAccessCategory[];
}

type Member = Record<string, unknown>;

/**
 * Summarise a player view for the audit trail. `fallbackId` (the identifier the
 * agent actually looked up) is used when the gateway record carries neither
 * userId nor memberId, so the audit row always names a subject.
 */
export function summarizePlayerAccess(member: Member, fallbackId?: string | null): PlayerAccessSummary {
  const playerId = str(member.userId) ?? str(member.memberId) ?? (fallbackId != null ? String(fallbackId) : null);

  const accessed: PlayerAccessCategory[] = [];
  if (str(member.balance) || str((member as { balanceCy?: unknown }).balanceCy)) accessed.push('balance');
  if (str(member.vipLevel) || str((member as { vipTier?: unknown }).vipTier)) accessed.push('vip');
  if (
    str(member.email) || str(member.mobile) || str(member.dob) ||
    str(member.country) || str((member as { city?: unknown }).city) ||
    str((member as { street?: unknown }).street)
  ) {
    accessed.push('contact');
  }

  return { playerId, accessed };
}
