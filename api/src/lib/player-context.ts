// Player-context enrichment for the headless AI-draft pipeline (capability B).
//
// When the triage worker drafts a reply, it can pull the customer's live player
// record from Maestro — balance, VIP tier, KYC/RG status, recent bonuses — so
// the draft is grounded in real account state instead of guessing. This runs
// with the app's `mh_live_*` API token (no signed-in user) + X-Brand-Id, via
// lib/maestro.ts workerFetch.
//
// Everything here is BEST-EFFORT and additive: if Maestro isn't configured, the
// player can't be resolved, or any call fails, we return null and triage
// proceeds exactly as before. Player data must never block a support reply.

import { workerFetch, workerMaestroConfigured, MaestroError, str } from './maestro.js';

interface PlayerLookup {
  email?: string | null;
  username?: string | null;
  /** Override the install's default brand (MAESTRO_BRAND_ID) when known. */
  brandId?: string | null;
}

// Maestro member records are deliberately loosely typed here — the gateway owns
// the canonical shape and we only read a curated, defensive subset.
type Member = Record<string, unknown>;

function pick(obj: Member, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = str(obj[k]);
    if (v) return v;
  }
  return null;
}

/**
 * Resolve the player and return a compact, prompt-ready context block, or null
 * if nothing usable could be fetched. The block is plain text designed to drop
 * straight into the triage user message.
 */
export async function buildPlayerContext(lookup: PlayerLookup): Promise<string | null> {
  if (!workerMaestroConfigured()) return null;
  if (!lookup.email && !lookup.username) return null;

  // Member lookup is by ONE exact key; the gateway's `email` param matches an
  // email OR a username, so we forward whichever we have on that param.
  let member: Member | null = null;
  try {
    const res = await workerFetch<Member>('/api/v1/proxy/member/lookup', {
      brandId: lookup.brandId ?? null,
      query: { email: lookup.email ?? lookup.username ?? undefined },
    });
    // Not-found is HTTP 200 with { success:false, errorCode:101 } — treat as no data.
    member = res && res.success !== false && res.errorCode !== 101 ? res : null;
  } catch (err) {
    if (err instanceof MaestroError && err.status !== 404) {
      console.warn('[player-context] member lookup failed:', err.status, err.message);
    }
    return null;
  }
  if (!member) return null;

  const lines: string[] = [];
  const vip = pick(member, 'vipLevel', 'vipTier', 'tier');
  const kyc = pick(member, 'kycStatus', 'kyc');
  const country = pick(member, 'country');
  const bal = str(member.balance);
  const balCy = pick(member, 'balanceCy', 'currency');
  const balance = bal ? `${bal}${balCy ? ' ' + balCy : ''}` : null;

  if (vip) lines.push(`VIP level: ${vip}`);
  if (balance) lines.push(`Balance: ${balance}`);
  if (kyc) lines.push(`KYC: ${kyc}`);
  if (country) lines.push(`Country: ${country}`);
  // NOTE: AML risk level (attributes.amlRiskLevel) is deliberately NOT sent to
  // the LLM — it's a higher-tier compliance signal pending a data-handling/DPA
  // sign-off. Re-add here once cleared.

  // NOTE: responsible-gambling (rg:read) had its own /proxy/members/<id>/rg call
  // here — removed: that path 404s and the platform hasn't confirmed an RG
  // endpoint. Re-add once the Maestro team gives us the contract.

  if (lines.length === 0) return null;
  return `PLAYER CONTEXT (live, from Maestro — use only what's relevant; never expose internal ids):\n${lines.map((l) => `- ${l}`).join('\n')}`;
}
