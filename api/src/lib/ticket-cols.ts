// ─── Shared ticket list-row column set ──────────────────────────────────────
// The exact shape the SPA's mapTicket() expects. Extracted from
// routes/tickets.ts so every producer of a "list row" emits the identical set:
// GET /tickets, the post-create re-select, and the per-customer profile
// endpoints in routes/customers.ts.
//
// Why identical matters: core/bootstrap.js's updateOrInsertTicket() assigns
// every field unconditionally (`t.lastMessageRole = row.last_message_role ||
// null`), so a producer that omits a column doesn't leave the existing value
// alone — it nulls it. A profile row inserted into TICKETS on click would
// quietly wipe live data if this drifted.
//
// Built per call, never at module scope: evaluating it at import time would
// open a DB handle before the app is configured.
//
// GET /sync deliberately keeps its own slimmer set; it also ships tombstones.

import type { getDb } from './db.js';

export function ticketListCols(sql: ReturnType<typeof getDb>) {
  return sql`id, display_id, subject, status_key, priority_key, category_key, assigned_user_id,
    customer_id, sla_state, created_at, updated_at, snoozed_until, snoozed_at, snooze_reason,
    snooze_woken_at, merged_into_id, merged_at, status_before_merge, latest_customer_sentiment,
    (select tm.role from ticket_messages tm
       where tm.ticket_id = tickets.id and tm.deleted_at is null
       order by tm.created_at desc limit 1) as last_message_role`;
}
