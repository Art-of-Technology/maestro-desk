// Player identity linking — attach a contact to its Maestro player.
//
// Contacts created from inbound email / the portal are stubs (name + email).
// This module asks the Maestro gateway for the player behind that email and,
// on an exact match, stores the player's stable ids on the customers row
// (maestro_user_id = the global Maestro id, maestro_member_id = the per-brand
// member number) and fills username / VIP tier / country ONLY where the
// contact has none — an agent's value is never overwritten.
//
// Everything here is BEST-EFFORT and additive, like lib/player-context.ts: a
// missing token, a workspace without a brand, an unreachable gateway or any DB
// error is logged and swallowed. Linking must never fail an inbound webhook or
// a portal submission — those call linkCustomerToPlayer fire-and-forget.
//
// The brand id comes from the contact's OWN workspace (workspaces.
// maestro_brand_id), never from a caller, so a lookup can only pull a brand's
// player data into the workspace that projects that brand. Ids are never
// added to the triage prompt (the LLM boundary in lib/player-context.ts is
// unchanged).

import type postgres from 'postgres';
import { getDb } from './db.js';
import { workerFetch, workerMaestroConfigured, MaestroError, str } from './maestro.js';
import { maestroBrandIdForWorkspace } from './maestro-workspace.js';
import { writeAudit } from '../middleware/platform-admin.js';
import type { PlayerAccessCategory } from './player-audit.js';

type Db = postgres.Sql<{}> | postgres.TransactionSql<{}>;
type Member = Record<string, unknown>;

export type LinkReason = 'inbound_email' | 'portal' | 'backfill';

export type LinkOutcome =
  | 'linked'          // ids written (and blanks filled)
  | 'not_found'       // gateway knows no player with this email; lookup stamped
  | 'email_mismatch'  // gateway matched a USERNAME, not the email; stamped, nothing written
  | 'unconfigured'    // no MAESTRO_API_TOKEN
  | 'no_brand'        // workspace is not a Maestro brand (unrouted bucket, legacy tenant)
  | 'skipped'         // erased / merged-away / no email / already linked / checked recently
  | 'failed';         // gateway or DB error (logged)

/** How long a not-found / mismatch answer is trusted before we ask again. */
export const LOOKUP_TTL_MS = 24 * 60 * 60 * 1000;

/** The gateway signals "no such member" with an HTTP 200 envelope, not a 404. */
export function memberNotFound(res: Member | null | undefined): boolean {
  return !res || res.success === false || res.errorCode === 101;
}

/**
 * Write a player's identity onto a customer. The ids are Maestro's, so they are
 * set outright (coalesce'd against the incoming value only so a lookup that
 * omits one can't blank a stored one); username / vip_tier / jurisdiction only
 * fill a blank. Erased profiles are never touched. Returns true when a row
 * was updated. Shared by the automatic linker and POST /customers/from-player
 * so the field mapping (vipLevel → vip_tier, country → jurisdiction) can't
 * drift between them.
 */
export async function applyPlayerToCustomer(
  sql: Db,
  args: { workspaceId: string; customerId: string; member: Member },
): Promise<boolean> {
  const m = args.member;
  const rows = await sql<{ id: string }[]>`
    update customers set
      maestro_user_id   = coalesce(${str(m.userId)}, maestro_user_id),
      maestro_member_id = coalesce(${str(m.memberId)}, maestro_member_id),
      username          = coalesce(username, ${str(m.username)}),
      vip_tier          = coalesce(vip_tier, ${str(m.vipLevel)}),
      jurisdiction      = coalesce(jurisdiction, ${str(m.country)}),
      player_lookup_at  = now()
    where id = ${args.customerId} and workspace_id = ${args.workspaceId}
      and erased_at is null and deleted_at is null
    returning id
  `;
  return rows.length > 0;
}

/**
 * Link one contact to its Maestro player by email. Never throws — every
 * failure path logs and resolves to an outcome, so callers can `void` it.
 */
export async function linkCustomerToPlayer(args: {
  workspaceId: string;
  customerId: string;
  reason: LinkReason;
}): Promise<LinkOutcome> {
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

interface CustomerRow {
  email: string | null;
  maestro_user_id: string | null;
  player_lookup_at: Date | string | null;
  erased_at: Date | string | null;
  merged_into_customer_id: string | null;
}

async function link(args: { workspaceId: string; customerId: string; reason: LinkReason }): Promise<LinkOutcome> {
  if (!workerMaestroConfigured()) return 'unconfigured';
  const sql = getDb();

  const [c] = await sql<CustomerRow[]>`
    select email, maestro_user_id, player_lookup_at, erased_at, merged_into_customer_id
    from customers
    where id = ${args.customerId} and workspace_id = ${args.workspaceId} and deleted_at is null
  `;
  if (!c || c.erased_at || c.merged_into_customer_id || !c.email || c.maestro_user_id) return 'skipped';
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
      query: { email: c.email },
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
  if (!memberEmail || memberEmail.toLowerCase() !== c.email.toLowerCase()) {
    await stampLookup(sql, args);
    return 'email_mismatch';
  }

  const updated = await applyPlayerToCustomer(sql, { workspaceId: args.workspaceId, customerId: args.customerId, member });
  if (!updated) return 'skipped';

  // Same shape as 'player.viewed' (routes/maestro.ts): categories, never
  // values. System actor — no signed-in user drives this.
  const accessed: PlayerAccessCategory[] = ['contact'];
  if (str(member.vipLevel)) accessed.push('vip');
  await writeAudit({
    workspaceId: args.workspaceId,
    actorUserId: null,
    action: 'customer.player_linked',
    targetType: 'customer',
    targetId: args.customerId,
    metadata: { brand_id: brandId, reason: args.reason, accessed },
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
  skipped: number;
  failed: number;
  /** Unlinked, never-checked contacts still waiting after this run — re-run until 0. */
  remaining: number;
}

/**
 * Walk every Maestro-brand workspace and link its unlinked, never-checked
 * contacts, `perWorkspace` at a time with bounded concurrency. Idempotent:
 * every contact it touches is either linked or stamped, so re-running
 * converges. `failed` outcomes are NOT stamped (they retry next run).
 */
export async function runPlayerIdentityBackfillJob(
  opts: { perWorkspace?: number; concurrency?: number } = {},
): Promise<PlayerIdentityBackfillResult> {
  const perWorkspace = opts.perWorkspace ?? 500;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const sql = getDb();
  const result: PlayerIdentityBackfillResult = {
    workspaces: 0, attempted: 0, linked: 0, notFound: 0, mismatched: 0, skipped: 0, failed: 0, remaining: 0,
  };

  if (!workerMaestroConfigured()) {
    console.warn('[player-identity] backfill skipped: MAESTRO_API_TOKEN is not configured');
    result.remaining = await countRemaining(sql);
    return result;
  }

  const workspaces = await sql<{ id: string }[]>`
    select id from workspaces where maestro_brand_id is not null and deleted_at is null order by created_at
  `;
  result.workspaces = workspaces.length;

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
        else if (o === 'failed') result.failed++;
        else result.skipped++;
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
