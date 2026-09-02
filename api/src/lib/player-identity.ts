// Player identity linking — attach a contact to its Maestro player.
//
// Contacts created from inbound email / the portal are stubs (name + email).
// This module asks the Maestro gateway for the player behind the address that
// wrote in and, on an exact match, stores the player's stable ids on the
// customers row (maestro_user_id = the global Maestro id, maestro_member_id =
// the per-brand member number) and fills username / VIP tier / country ONLY
// where the contact has none — an agent's value is never overwritten, and a
// contact that already has a maestro_user_id is never re-pointed.
//
// Everything here is BEST-EFFORT and additive, like lib/player-context.ts: a
// missing token, a workspace without a brand, an unreachable gateway or any DB
// error is logged and swallowed. Linking must never fail an inbound webhook or
// a portal submission — those call scheduleLink() fire-and-forget.
//
// The brand id comes from the contact's OWN workspace (workspaces.
// maestro_brand_id), never from a caller, so a lookup can only pull a brand's
// player data into the workspace that projects that brand. Ids are never
// added to the triage prompt (the LLM boundary in lib/player-context.ts is
// unchanged).

import type postgres from 'postgres';
import { getDb } from './db.js';
import { workerFetch, workerMaestroConfigured, MaestroError, memberNotFound, str } from './maestro.js';
import { maestroBrandIdForWorkspace } from './maestro-workspace.js';
import { writeAudit } from '../middleware/platform-admin.js';
import type { PlayerAccessCategory } from './player-audit.js';

export { memberNotFound };

type Db = postgres.Sql<{}> | postgres.TransactionSql<{}>;
type Member = Record<string, unknown>;

export type LinkReason = 'inbound_email' | 'portal' | 'contact_edit' | 'backfill';

export type LinkOutcome =
  | 'linked'          // ids written (and blanks filled)
  | 'not_found'       // gateway knows no player with this email; lookup stamped
  | 'email_mismatch'  // gateway matched a USERNAME, not the email; stamped, nothing written
  | 'no_player_id'    // member record carries no userId — nothing stable to link to; stamped
  | 'unconfigured'    // no MAESTRO_API_TOKEN
  | 'no_brand'        // workspace is not a Maestro brand (unrouted bucket, legacy tenant)
  | 'skipped'         // erased / merged-away / no email / already linked / checked recently
  | 'failed';         // gateway or DB error (logged, NOT stamped — retried next time)

/** How long a not-found / mismatch answer is trusted before we ask again. */
export const LOOKUP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Audit categories for what a link PERSISTS onto the contact (mirrors the
 * 'player.viewed' vocabulary in lib/player-audit.ts; never the values). We
 * store contact data always (ids, username, country) and VIP when present —
 * balance is never persisted, so it's never claimed here.
 */
export function linkedCategories(member: Member): PlayerAccessCategory[] {
  const accessed: PlayerAccessCategory[] = ['contact'];
  if (str(member.vipLevel) ?? str(member.vipTier)) accessed.push('vip');
  return accessed;
}

/**
 * Write a player's identity onto an UNLINKED customer. The WHERE clause is the
 * whole safety story: a contact that already carries a maestro_user_id is never
 * re-pointed (two agents looking up different players who share an address,
 * or a stale secondary), and a concurrent duplicate link sees 0 rows instead of
 * writing twice. username / vip_tier / jurisdiction only fill a blank. Erased
 * profiles are never touched. A member record without a userId has nothing
 * stable to link to and writes nothing. Returns true when the contact was
 * linked by THIS call. Shared by the automatic linker and POST
 * /customers/from-player so the field mapping (vipLevel → vip_tier, country →
 * jurisdiction) can't drift between them.
 */
export async function applyPlayerToCustomer(
  sql: Db,
  args: { workspaceId: string; customerId: string; member: Member },
): Promise<boolean> {
  const m = args.member;
  const userId = str(m.userId);
  if (!userId) return false;
  const rows = await sql<{ id: string }[]>`
    update customers set
      maestro_user_id   = ${userId},
      maestro_member_id = ${str(m.memberId)},
      username          = coalesce(username, ${str(m.username)}),
      vip_tier          = coalesce(vip_tier, ${str(m.vipLevel) ?? str(m.vipTier)}),
      jurisdiction      = coalesce(jurisdiction, ${str(m.country)}),
      player_lookup_at  = now()
    where id = ${args.customerId} and workspace_id = ${args.workspaceId}
      and maestro_user_id is null and erased_at is null and deleted_at is null
    returning id
  `;
  return rows.length > 0;
}

export interface LinkArgs {
  workspaceId: string;
  customerId: string;
  reason: LinkReason;
  /**
   * The address that actually wrote in / was just added. A player whose casino
   * login is a SECONDARY address on the profile would never match on the
   * primary mirror, so callers that know the address pass it; the backfill
   * (which only knows the row) falls back to customers.email.
   */
  email?: string | null;
  /**
   * The signed-in agent whose action triggered the link (adding / promoting an
   * address). Recorded as the audit actor; omitted for headless paths (inbound
   * mail, portal, backfill), which audit as the system actor.
   */
  actorUserId?: string | null;
}

/**
 * Link one contact to its Maestro player by email. Never throws — every
 * failure path logs and resolves to an outcome, so callers can `void` it.
 */
export async function linkCustomerToPlayer(args: LinkArgs): Promise<LinkOutcome> {
  try {
    return await link(args);
  } catch (err) {
    console.warn(
      `[player-identity] link failed (${args.reason}, customer ${args.customerId}):`,
      err instanceof Error ? err.message : err,
    );
    return 'failed';
  }
}

/**
 * Fire-and-forget wrapper for request paths. On Vercel (staging / previews) a
 * function can be frozen the moment the response is sent, so the pending work
 * is registered with waitUntil — same guard as lib/outgoing-webhooks.ts. On
 * the long-running Node container (prod) the promise simply runs on.
 */
export function scheduleLink(args: LinkArgs): void {
  const p = linkCustomerToPlayer(args);
  if (process.env.VERCEL) {
    void import('@vercel/functions').then(({ waitUntil }) => waitUntil(p));
  }
}

interface CustomerRow {
  email: string | null;
  maestro_user_id: string | null;
  player_lookup_at: Date | string | null;
  erased_at: Date | string | null;
  merged_into_customer_id: string | null;
}

async function link(args: LinkArgs): Promise<LinkOutcome> {
  if (!workerMaestroConfigured()) return 'unconfigured';
  const sql = getDb();

  const [c] = await sql<CustomerRow[]>`
    select email, maestro_user_id, player_lookup_at, erased_at, merged_into_customer_id
    from customers
    where id = ${args.customerId} and workspace_id = ${args.workspaceId} and deleted_at is null
  `;
  if (!c || c.erased_at || c.merged_into_customer_id || c.maestro_user_id) return 'skipped';
  const email = str(args.email) ?? c.email;
  if (!email) return 'skipped';
  if (c.player_lookup_at && Date.now() - new Date(c.player_lookup_at).getTime() < LOOKUP_TTL_MS) return 'skipped';

  const brandId = await maestroBrandIdForWorkspace(args.workspaceId);
  if (!brandId) return 'no_brand';

  // Lookup is by ONE exact key. Not-found is a 200 envelope (memberNotFound);
  // a 404 from the gateway is treated the same way. Anything else propagates
  // to the outer catch as 'failed' WITHOUT stamping, so a transient outage
  // gets retried on the contact's next email rather than waiting a day.
  let member: Member | null;
  try {
    const res = await workerFetch<Member>('/api/v1/proxy/member/lookup', {
      brandId,
      query: { email },
    });
    member = memberNotFound(res) ? null : res;
  } catch (err) {
    if (err instanceof MaestroError && err.status === 404) member = null;
    else throw err;
  }

  if (!member) {
    await stampLookup(sql, args);
    return 'not_found';
  }

  // The gateway's `email` param also matches usernames. A contact whose email
  // happens to equal some OTHER player's username would otherwise be linked to
  // that player — so only an exact (case-insensitive) email match counts.
  const memberEmail = str(member.email);
  if (!memberEmail || memberEmail.toLowerCase() !== email.toLowerCase()) {
    await stampLookup(sql, args);
    return 'email_mismatch';
  }

  // No global id → nothing stable to link to. Stamp so we don't re-ask daily.
  if (!str(member.userId)) {
    await stampLookup(sql, args);
    return 'no_player_id';
  }

  const linked = await applyPlayerToCustomer(sql, { workspaceId: args.workspaceId, customerId: args.customerId, member });
  if (!linked) return 'skipped';   // a concurrent link won, or the row changed under us

  // Same shape as 'player.viewed' (routes/maestro.ts): categories, never
  // values. Actor = the agent whose contact edit triggered this, else the
  // system (inbound mail / portal / backfill have no signed-in user).
  await writeAudit({
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId ?? null,
    action: 'customer.player_linked',
    targetType: 'customer',
    targetId: args.customerId,
    metadata: { brand_id: brandId, reason: args.reason, accessed: linkedCategories(member) },
  });
  return 'linked';
}

async function stampLookup(sql: Db, args: { workspaceId: string; customerId: string }): Promise<void> {
  await sql`
    update customers set player_lookup_at = now()
    where id = ${args.customerId} and workspace_id = ${args.workspaceId}
  `;
}

// ─── One-off backfill (cron-run.ts `player-identity-backfill`) ─────────────

export interface PlayerIdentityBackfillResult {
  workspaces: number;
  attempted: number;
  linked: number;
  notFound: number;
  mismatched: number;
  noPlayerId: number;
  skipped: number;
  failed: number;
  /** Unlinked, never-checked contacts still waiting after this run — re-run until 0. */
  remaining: number;
}

/** Consecutive 'failed' outcomes that abort a run — a dead/expired token or a
 *  brand the app isn't installed on fails EVERY lookup, and hammering the
 *  gateway 500 more times won't change that. */
export const BACKFILL_ABORT_AFTER_FAILURES = 5;

/**
 * Walk every Maestro-brand workspace and link its unlinked, never-checked
 * contacts, `perWorkspace` at a time with bounded concurrency. Idempotent:
 * every contact it touches is either linked or stamped, so re-running
 * converges. `failed` outcomes are NOT stamped (they retry next run); a run
 * of consecutive failures THROWS (cron-run exits 1) with the partial counts,
 * so an operator "repeating until remaining = 0" can't loop on a broken token.
 */
export async function runPlayerIdentityBackfillJob(
  opts: { perWorkspace?: number; concurrency?: number } = {},
): Promise<PlayerIdentityBackfillResult> {
  const perWorkspace = opts.perWorkspace ?? 500;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const sql = getDb();
  const result: PlayerIdentityBackfillResult = {
    workspaces: 0, attempted: 0, linked: 0, notFound: 0, mismatched: 0, noPlayerId: 0, skipped: 0, failed: 0, remaining: 0,
  };

  if (!workerMaestroConfigured()) {
    result.remaining = await countRemaining(sql);
    throw new Error(`player-identity backfill: MAESTRO_API_TOKEN is not configured (${result.remaining} contacts waiting)`);
  }

  const workspaces = await sql<{ id: string }[]>`
    select id from workspaces where maestro_brand_id is not null and deleted_at is null order by created_at
  `;
  result.workspaces = workspaces.length;

  let consecutiveFailures = 0;
  for (const ws of workspaces) {
    const candidates = await sql<{ id: string }[]>`
      select id from customers
      where workspace_id = ${ws.id}
        and maestro_user_id is null and email is not null and player_lookup_at is null
        and erased_at is null and deleted_at is null and merged_into_customer_id is null
      order by created_at asc
      limit ${perWorkspace}
    `;
    for (let i = 0; i < candidates.length; i += concurrency) {
      const outcomes = await Promise.all(
        candidates.slice(i, i + concurrency).map((c) =>
          linkCustomerToPlayer({ workspaceId: ws.id, customerId: c.id, reason: 'backfill' }),
        ),
      );
      for (const o of outcomes) {
        result.attempted++;
        if (o === 'linked') result.linked++;
        else if (o === 'not_found') result.notFound++;
        else if (o === 'email_mismatch') result.mismatched++;
        else if (o === 'no_player_id') result.noPlayerId++;
        else if (o === 'failed') result.failed++;
        else result.skipped++;
        consecutiveFailures = o === 'failed' ? consecutiveFailures + 1 : 0;
      }
      if (consecutiveFailures >= BACKFILL_ABORT_AFTER_FAILURES) {
        result.remaining = await countRemaining(sql);
        throw new Error(
          `player-identity backfill aborted after ${consecutiveFailures} consecutive gateway failures ` +
          `(check MAESTRO_API_TOKEN / brand installation): ${JSON.stringify(result)}`,
        );
      }
    }
  }

  result.remaining = await countRemaining(sql);
  return result;
}

async function countRemaining(sql: Db): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n
    from customers c
    join workspaces w on w.id = c.workspace_id
    where w.maestro_brand_id is not null and w.deleted_at is null
      and c.maestro_user_id is null and c.email is not null and c.player_lookup_at is null
      and c.erased_at is null and c.deleted_at is null and c.merged_into_customer_id is null
  `;
  return n;
}
