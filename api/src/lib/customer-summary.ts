// ─── Per-customer history summary ───────────────────────────────────────────
// Everything the customer profile page needs about a customer's ticket
// history, computed server-side in one round trip.
//
// Why this exists: the SPA derived all of it from its in-memory TICKETS array,
// which holds only the first page of the workspace's tickets — and, worse,
// list rows carry no tags, no csat_score and no messages at all. So the
// profile's CSAT tile, "Common topics" card and activity timeline were
// *structurally* empty on any live workspace, and its counts only ever saw the
// first page. A profile that under-reports the number an agent acts on is
// worse than one that loads a beat later.
//
// Shaped like lib/gdpr-export.ts: a pure {workspaceId, customerId} → object
// function returning null when the customer isn't visible in the workspace, so
// the route can 404 without a second existence query.
//
// Scoped by workspace_id on EVERY table touched — tickets, ticket_tags,
// ticket_messages. There is no RLS backstop (see CLAUDE.md), and ticket_tags
// carries workspace_id as a plain column with no FK, so it gets the predicate
// as well as the join.
//
// DELIBERATELY ABSENT: an SLA-breach count. tickets.sla_state is only ever
// written as 'ok' by the real insert paths (lib/inbound-email.ts,
// routes/public.ts, routes/inbox.ts) and left NULL by POST /tickets; 'breach'
// and 'warn' exist only in the demo seed. Breach evaluation is client-side
// against the workspace's SLA policies and business hours (web/js/tickets/
// sla.js, and see the header of routes/reports.ts). Counting the column here
// would have shipped a tile that reads 0 on every live workspace — exactly the
// structurally-empty panel this module exists to remove. The profile's own
// "SLA breaches" risk flag reads the same dead column and has the same
// problem; that belongs with the flags-panel work, not here.

import { getDb } from './db.js';
import { ticketListCols } from './ticket-cols.js';

/** Newest messages shown in the profile's activity timeline. */
const ACTIVITY_LIMIT = 15;
/** Message-bearing tickets scanned to find them — see the note in activity(). */
const ACTIVITY_TICKET_WINDOW = 50;
/** "Common topics" chips. */
const TAG_LIMIT = 8;
/** The timeline renders one ellipsized line, so full bodies are wasted bytes and extra PII on the wire. */
const BODY_PREVIEW_CHARS = 300;
/**
 * Roles that count as conversation. 'system' is excluded because a customer
 * merge stamps a marker onto every moved ticket in one statement
 * (routes/customers.ts) — merging a duplicate holding 15+ tickets would
 * otherwise fill the entire timeline with identical markers and evict the real
 * history. Those markers carry a NULL merged_from_id, so the predicate below
 * doesn't catch them.
 */
const ACTIVITY_ROLES = ['customer', 'agent', 'ai', 'note'] as const;

export const CUSTOMER_TICKETS_DEFAULT_LIMIT = 25;
export const CUSTOMER_TICKETS_MAX_LIMIT = 100;

export interface CustomerSummary {
  customer_id: string;
  totals: {
    tickets: number;
    merged: number;
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
 * Is this customer visible in this workspace?
 *
 * Returns false for missing, wrong-workspace AND soft-deleted, so all three
 * answer 404 identically and the endpoint can't be used as a cross-tenant
 * existence oracle. The deleted_at predicate matters: DELETE /customers/:id
 * soft-deletes the profile and hard-deletes its notes specifically to hide it,
 * and without this the summary would keep serving its full ticket history and
 * message previews after that.
 *
 * (lib/gdpr-export.ts deliberately ignores deleted_at because a subject access
 * request must include deleted records. That rationale does not transfer to a
 * profile view, so this is not the same check.)
 */
export async function customerVisible(workspaceId: string, customerId: string): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    select 1 from customers
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Scalar rollup. One materialized CTE and a single aggregate pass over it:
 * `count(*) filter (...)` rather than a subquery per statistic, because each
 * scalar subquery would be its own InitPlan re-scanning the whole tuplestore —
 * eight passes for a job that takes one.
 *
 * by_status is returned as a jsonb map rather than named open/escalated/…
 * columns on purpose: ticket_statuses is a PER-WORKSPACE lookup table, so
 * 'open' and 'gdpr' are seed conventions, not schema. Handing the raw map back
 * lets the SPA keep the exact predicates it already uses without baking one
 * workspace's status keys into SQL.
 *
 * last_ticket_at is max(created_at), symmetric with first_ticket_at, and NOT
 * max(updated_at): the child-row triggers bump updated_at on tag adds, AI-tag
 * accepts and time entries, so retagging a two-year-old ticket would otherwise
 * report the customer's last ticket as a moment ago.
 */
async function rollup(workspaceId: string, customerId: string) {
  const sql = getDb();
  const [row] = await sql<Array<Record<string, unknown>>>`
    with t as materialized (
      select status_key, csat_score, merged_into_id, created_at
      from tickets
      where workspace_id = ${workspaceId} and customer_id = ${customerId} and deleted_at is null
    ),
    agg as (
      select count(*)::int                                          as total,
             count(*) filter (where merged_into_id is not null)::int as merged,
             count(csat_score)::int                                  as csat_count,
             avg(csat_score)::float                                  as csat_avg,
             min(created_at)                                         as first_ticket_at,
             max(created_at)                                         as last_ticket_at
      from t
    ),
    statuses as (
      select coalesce(jsonb_object_agg(status_key, n), '{}'::jsonb) as by_status
      from (select status_key, count(*)::int n from t group by status_key) s
    )
    select agg.*, statuses.by_status from agg, statuses
  `;
  return row;
}

/**
 * Top tags across the customer's tickets.
 *
 * Deliberately spans their whole history rather than a recent window: these are
 * "common topics for this customer", and a window would silently drop a
 * recurring theme once it aged out, which is a worse failure than the cost.
 * The cost is bounded by the (workspace_id, customer_id, updated_at desc)
 * index added alongside this module — one index range scan plus a PK probe per
 * ticket into ticket_tags.
 */
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
 * The newest real messages across the customer's tickets.
 *
 * Bounded to the customer's most-recently-updated MESSAGE-BEARING tickets
 * rather than joining every ticket they have ever had — a 5,000-ticket
 * customer would otherwise mean 5,000 index probes to show fifteen lines.
 *
 * The `exists` clause is what makes that bound safe. bump_ticket_on_message
 * keeps a ticket's updated_at fresh when it gains a message, but sibling
 * triggers (bump_ticket_on_tag, _ai_tag, _time_entry) and plain
 * `update tickets` statements — bulk status changes, triage summaries,
 * sentiment writes, the customer-merge sweep — bump it too. Without the
 * filter, a customer with 50+ message-less tickets touched more recently than
 * any conversation would get an empty timeline: the exact failure this module
 * exists to fix.
 */
async function activity(workspaceId: string, customerId: string) {
  const sql = getDb();
  return sql<Array<Record<string, unknown>>>`
    with recent as (
      select t.id, t.display_id
      from tickets t
      where t.workspace_id = ${workspaceId}
        and t.customer_id = ${customerId}
        and t.deleted_at is null
        and exists (
          select 1 from ticket_messages m
          where m.ticket_id = t.id
            and m.workspace_id = ${workspaceId}
            and m.deleted_at is null
            and m.merged_from_id is null
            and m.role in ${sql(ACTIVITY_ROLES)}
        )
      order by t.updated_at desc, t.id desc
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
      and m.role in ${sql(ACTIVITY_ROLES)}
    order by m.created_at desc, m.id desc
    limit ${ACTIVITY_LIMIT}
  `;
}

/**
 * One page of the customer's tickets, in the shared list-row shape so the SPA
 * can insert a row straight into TICKETS when an agent clicks through to a
 * ticket outside the loaded window.
 *
 * `csat_score` rides along as an extra beyond the shared set. Note for the web
 * side: mapTicket() hardcodes `csat: null` and updateOrInsertTicket()
 * deliberately leaves `csat` alone, so the profile must read this column from
 * its own cached rows — it will not survive a trip through the shared mapper.
 *
 * count(*) over() scans all of the customer's rows, so it's computed on the
 * first page only — the same trade GET /tickets makes. The `id` tie-break is
 * load-bearing: a customer merge stamps a batch of tickets with the same
 * updated_at in one transaction, and without it consecutive offset pages can
 * repeat one row and skip another.
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
    order by updated_at desc, id desc
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

  if (!(await customerVisible(workspaceId, customerId))) return null;

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
