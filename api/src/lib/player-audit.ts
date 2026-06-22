// Summarise a player-data view for the read-access audit trail.
//
// Regulators expect a "who looked at this account" record. We log the stable
// player identifier + which CATEGORIES of sensitive data were exposed — never
// the values themselves (the audit log must not become a second copy of the
// player's PII).

import { str } from './maestro.js';

export interface PlayerAccessSummary {
  // Stable Maestro identifier for the viewed player (never their email).
  playerId: string | null;
  // Sensitive data categories present in the returned record.
  accessed: string[];
}

type Member = Record<string, unknown>;

export function summarizePlayerAccess(member: Member): PlayerAccessSummary {
  const playerId = str(member.userId) ?? str(member.memberId) ?? null;

  const accessed: string[] = [];
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
