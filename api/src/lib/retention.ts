// Data-retention purge (owner decision 2026-06-22): delete resolved tickets once
// they pass their workspace's retention window, measured from resolved_at. The
// PII-bearing child ROWS (messages, attachments, csat, time entries, viewers, …)
// are removed by the ON DELETE CASCADE FKs to tickets; aggregate logs that
// reference a ticket with ON DELETE SET NULL (ai_usage_log, automation events)
// are retained with their ticket link nulled.
//
// Attachment FILES live in R2 (ticket_attachments.storage_key) and the cascade
// can't reach them, so each batch gathers the keys of the tickets it is about
// to delete (inside the same transaction) and deletes the objects AFTER commit
// — R2 isn't transactional, and we never want rows rolled back to point at
// already-deleted files. A failed object delete is parked in
// pending_object_deletions; retryPendingObjectDeletions() (same cron) retries
// until the keys are gone, mirroring gdpr-erasure.ts.
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
import { attachmentsStore } from './r2.js';

export interface RetentionDeps {
  // Injectable so tests can record the keys without R2 config or a network call.
  deleteObjects?: (keys: string[]) => Promise<void>;
}

export async function purgeExpiredTickets(
  batchSize = 500,
  deps: RetentionDeps = {},
): Promise<{ purgedTickets: number; objectsDeleted: number; objectsParked: number }> {
  const deleteObjects = deps.deleteObjects ?? ((keys: string[]) => attachmentsStore().deleteKeys(keys));
  const db = getDb();
  const batch = Math.max(1, batchSize); // guard against a 0/negative → infinite loop
  let purgedTickets = 0;
  let objectsDeleted = 0;
  let objectsParked = 0;
  for (;;) {
    const { count, keys } = await db.begin(async (sql) => {
      const expiring = await sql<{ id: string }[]>`
        select t.id
        from tickets t
        join workspaces w on w.id = t.workspace_id
        where w.deleted_at is null
          and w.retention_days is not null
          and t.resolved_at is not null
          and t.resolved_at < now() - make_interval(days => w.retention_days)
        limit ${batch}
      `;
      if (expiring.length === 0) return { count: 0, keys: [] as string[] };
      const ids = expiring.map((r) => r.id);
      const atts = await sql<{ storage_key: string }[]>`
        select storage_key from ticket_attachments where ticket_id in ${sql(ids)}
      `;
      const deleted = await sql`delete from tickets where id in ${sql(ids)}`;
      return { count: deleted.count, keys: atts.map((a) => a.storage_key) };
    });
    purgedTickets += count;

    if (keys.length) {
      try {
        await deleteObjects(keys);
        objectsDeleted += keys.length;
      } catch (err) {
        console.error(
          `[retention] R2 object deletion failed for ${keys.length} attachment(s) — parking for retry:`,
          err instanceof Error ? err.message : err,
        );
        // Park for the retry sweep. If even this fails, log — never let it mask
        // the successful row purge.
        try {
          await db`
            insert into pending_object_deletions (storage_key, reason)
            select k, 'retention' from unnest(${keys}::text[]) as k
            on conflict (storage_key) do nothing
          `;
          objectsParked += keys.length;
        } catch (persistErr) {
          console.error('[retention] failed to park pending object keys:', persistErr instanceof Error ? persistErr.message : persistErr);
        }
      }
    }

    if (count < batch) break;
  }
  return { purgedTickets, objectsDeleted, objectsParked };
}
