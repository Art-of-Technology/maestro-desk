// Summarise a player-data view for the read-access audit trail.
//
// Regulators expect a "who looked at this account" record. We log the stable
// player identifier + which CATEGORIES of sensitive data were exposed — never
// the values themselves (the audit log must not become a second copy of the
// player's PII).

import { str } from './maestro.js';

// The exact category strings written to the audit trail. Exported so downstream
// consumers (reporting, the append-only hardening, regulator tooling) share one
// contract and typos can't drift in.
export const PLAYER_ACCESS_CATEGORIES = ['balance', 'kyc', 'vip', 'contact'] as const;
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
  if (str(member.kycStatus) || str((member as { kyc?: unknown }).kyc)) accessed.push('kyc');
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
