// ─── Per-customer history summary ───────────────────────────────────────────
// Everything the customer profile page needs about a customer's ticket
// history, computed server-side in one round trip.
//
// Why this exists: the SPA derived all of it from its in-memory TICKETS array,
// which holds only the first page of the workspace's tickets — and, worse,
// list rows carry no tags, no csat_score and no messages at all. So the
// profile's CSAT tile, "Common topics" card and activity timeline were
// *structurally* empty on any live workspace, and its counts and risk flags
// only ever saw the first page. A profile that under-reports the number an
// agent acts on is worse than one that loads a beat later.
//
// Shaped like lib/gdpr-export.ts: a pure {workspaceId, customerId} → object
// function returning null when the customer isn't in the workspace, so the
// route can 404 without a second existence query.
//
// Scoped by workspace_id on EVERY table touched — tickets, ticket_tags,
// ticket_messages. There is no RLS backstop (see CLAUDE.md), and ticket_tags
// carries workspace_id as a plain column with no FK, so it gets the predicate
// as well as the join.

import { getDb } from './db.js';
import { ticketListCols } from './ticket-cols.js';

/** Newest messages shown in the profile's activity timeline. */
const ACTIVITY_LIMIT = 15;
/** Recent tickets scanned to find those messages — see the note in activity(). */
const ACTIVITY_TICKET_WINDOW = 50;
/** "Common topics" chips. */
const TAG_LIMIT = 8;
/** The timeline renders one ellipsized line, so full bodies are wasted bytes and extra PII on the wire. */
const BODY_PREVIEW_CHARS = 300;

export const CUSTOMER_TICKETS_DEFAULT_LIMIT = 25;
export const CUSTOMER_TICKETS_MAX_LIMIT = 100;

export interface CustomerSummary {
  customer_id: string;
  totals: {
    tickets: number;
    merged: number;
    sla_breaches: number;
    csat_count: number;
    csat_avg: number | null;
    first_ticket_at: string | null;
    last_ticket_at: string | null;
  };
  /** status_key → count. A map, not named fields — see the note below. */
  by_status: Record<string, number>;
  tags: Array<{ tag: string; n: number }>;
  activity: Array<Record<string, unknown>>;
  tickets: { rows: Array<Record<string, unknown>>; total: number; limit: number; offset: number };
}

/**
 * Confirm the customer exists in this workspace. Returns false for both
 * "missing" and "belongs to another workspace" so callers answer 404
 * identically and the endpoint can't be used as a cross-tenant existence
 * oracle.
 */
async function customerExists(workspaceId: string, customerId: string): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    select 1 from customers
    where id = ${customerId} and workspace_id = ${workspaceId}
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Scalar rollup. One materialized CTE so the customer's tickets are scanned
 * once for all seven aggregates instead of once each.
 *
 * by_status is returned as a jsonb map rather than named open/escalated/…
 * columns on purpose: ticket_statuses is a PER-WORKSPACE lookup table, so
 * 'open' and 'gdpr' are seed conventions, not schema. Handing the raw map back
 * lets the SPA keep the exact predicates it already uses without baking one
 * workspace's status keys into SQL.
 */
async function rollup(workspaceId: string, customerId: string) {
  const sql = getDb();
  const [row] = await sql<Array<Record<string, unknown>>>`
    with t as materialized (
      select status_key, sla_state, csat_score, merged_into_id, created_at, updated_at
      from tickets
      where workspace_id = ${workspaceId} and customer_id = ${customerId} and deleted_at is null
    )
    select (select count(*) from t)::int                                  as total,
           (select count(*) from t where merged_into_id is not null)::int as merged,
           (select count(*) from t where sla_state = 'breach')::int       as sla_breaches,
           (select count(csat_score) from t)::int                         as csat_count,
           (select avg(csat_score) from t)::float                         as csat_avg,
           (select min(created_at) from t)                                as first_ticket_at,
           (select max(updated_at) from t)                                as last_ticket_at,
           (select coalesce(jsonb_object_agg(status_key, n), '{}'::jsonb)
              from (select status_key, count(*)::int n from t group by status_key) s) as by_status
  `;
  return row;
}

/** Top tags across the customer's tickets. */
async function topTags(workspaceId: string, customerId: string) {
  const sql = getDb();
  return sql<Array<{ tag: string; n: number }>>`
    select tt.tag, count(*)::int as n
    from ticket_tags tt
    join tickets t on t.id = tt.ticket_id
    where tt.workspace_id = ${workspaceId}
      and t.workspace_id = ${workspaceId}
      and t.customer_id = ${customerId}
      and t.deleted_at is null
    group by tt.tag
    order by n desc, tt.tag asc
    limit ${TAG_LIMIT}
  `;
}

/**
 * The newest messages across the customer's tickets.
 *
 * Bounded by the customer's most-recently-updated tickets rather than joining
 * every ticket they've ever had — a 5,000-ticket customer would otherwise mean
 * 5,000 index probes and a sort to show fifteen lines.
 *
 * That bound is sound because db/migrations/20260601140000_bump_ticket_updated_
 * at_on_children.sql installs bump_ticket_on_message: any message insert bumps
 * its ticket's updated_at, so the newest messages live in the most recently
 * updated tickets. The only way to miss one is if more than
 * ACTIVITY_TICKET_WINDOW tickets were bumped by non-message events (tags, time
 * entries) after those messages — acceptable for a timeline preview.
 *
 * merged_from_id is excluded so a merged thread's copied messages don't appear
 * twice, matching how the SLA-breach report treats them.
 */
async function activity(workspaceId: string, customerId: string) {
  const sql = getDb();
  return sql<Array<Record<string, unknown>>>`
    with recent as (
      select id, display_id from tickets
      where workspace_id = ${workspaceId} and customer_id = ${customerId} and deleted_at is null
      order by updated_at desc
      limit ${ACTIVITY_TICKET_WINDOW}
    )
    select r.display_id,
           m.ticket_id,
           m.role,
           m.author_label,
           left(m.body, ${BODY_PREVIEW_CHARS}) as body,
           length(m.body) > ${BODY_PREVIEW_CHARS} as body_truncated,
           m.created_at
    from ticket_messages m
    join recent r on r.id = m.ticket_id
    where m.workspace_id = ${workspaceId}
      and m.deleted_at is null
      and m.merged_from_id is null
    order by m.created_at desc
    limit ${ACTIVITY_LIMIT}
  `;
}

/**
 * One page of the customer's tickets, in the shared list-row shape so the SPA
 * can insert a row straight into TICKETS when an agent clicks through to a
 * ticket outside the loaded window.
 *
 * count(*) over() scans all of the customer's rows, so it's computed on the
 * first page only — the same trade GET /tickets makes.
 */
export async function customerTicketPage(args: {
  workspaceId: string;
  customerId: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: Array<Record<string, unknown>>; total: number | null; limit: number; offset: number }> {
  const sql = getDb();
  const { workspaceId, customerId } = args;
  const limit = Math.min(Math.max(args.limit ?? CUSTOMER_TICKETS_DEFAULT_LIMIT, 1), CUSTOMER_TICKETS_MAX_LIMIT);
  const offset = Math.max(args.offset ?? 0, 0);
  const withCount = offset === 0;

  const rows = await sql<Array<Record<string, unknown>>>`
    select ${ticketListCols(sql)}, csat_score
           ${withCount ? sql`, count(*) over() ::int as total_count` : sql``}
    from tickets
    where workspace_id = ${workspaceId} and customer_id = ${customerId} and deleted_at is null
    order by updated_at desc
    limit ${limit} offset ${offset}
  `;
  const total = withCount ? (rows.length > 0 ? Number(rows[0].total_count) : 0) : null;
  return { rows: rows.map(({ total_count, ...r }) => r), total, limit, offset };
}

export async function customerSummary(args: {
  workspaceId: string;
  customerId: string;
}): Promise<CustomerSummary | null> {
  const { workspaceId, customerId } = args;

  if (!(await customerExists(workspaceId, customerId))) return null;

  const [totalsRow, tags, timeline, page] = await Promise.all([
    rollup(workspaceId, customerId),
    topTags(workspaceId, customerId),
    activity(workspaceId, customerId),
    customerTicketPage({ workspaceId, customerId }),
  ]);

  return {
    customer_id: customerId,
    totals: {
      tickets: Number(totalsRow?.total ?? 0),
      merged: Number(totalsRow?.merged ?? 0),
      sla_breaches: Number(totalsRow?.sla_breaches ?? 0),
      csat_count: Number(totalsRow?.csat_count ?? 0),
      // avg() is null when there are no scores; don't coerce that to 0, which
      // would render as a real "0.0 CSAT" rather than "no ratings yet".
      csat_avg: totalsRow?.csat_avg == null ? null : Number(totalsRow.csat_avg),
      first_ticket_at: (totalsRow?.first_ticket_at as string) ?? null,
      last_ticket_at: (totalsRow?.last_ticket_at as string) ?? null,
    },
    by_status: (totalsRow?.by_status as Record<string, number>) ?? {},
    tags: tags.map((t) => ({ tag: t.tag, n: Number(t.n) })),
    activity: timeline,
    tickets: { rows: page.rows, total: page.total ?? 0, limit: page.limit, offset: page.offset },
  };
}
