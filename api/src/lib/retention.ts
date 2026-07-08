// Data-retention purge (owner decision 2026-06-22): delete resolved tickets once
// they pass their workspace's retention window, measured from resolved_at. The
// PII-bearing children (messages, attachments, csat, time entries, viewers, …)
// are removed by the ON DELETE CASCADE FKs to tickets; aggregate logs that
// reference a ticket with ON DELETE SET NULL (ai_usage_log, automation events)
// are retained with their ticket link nulled.
//
// Set-based across all workspaces, each applying its own retention_days — no
// per-workspace loop, so cost doesn't grow with brand count. NULL retention_days
// = purge disabled for that workspace (legal hold).
//
// Deleted in bounded batches rather than one statement: a large expiry backlog
// (and its ON DELETE CASCADE children) in a single transaction means a long
// lock, big WAL, and statement-timeout risk. Each batch is its own transaction,
// so total work is unchanged but no single one is unbounded. Termination: when a
// batch removes fewer than batchSize rows, nothing expired remains.

import { getDb } from './db.js';

export async function purgeExpiredTickets(batchSize = 500): Promise<{ purgedTickets: number }> {
  const sql = getDb();
  const batch = Math.max(1, batchSize); // guard against a 0/negative → infinite loop
  let purgedTickets = 0;
  for (;;) {
    const rows = await sql`
      delete from tickets
      where id in (
        select t.id
        from tickets t
        join workspaces w on w.id = t.workspace_id
        where w.deleted_at is null
          and w.retention_days is not null
          and t.resolved_at is not null
          and t.resolved_at < now() - make_interval(days => w.retention_days)
        limit ${batch}
      )
      returning id
    `;
    purgedTickets += rows.count;
    if (rows.count < batch) break;
  }
  return { purgedTickets };
}
