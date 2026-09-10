import { getDb } from './db.js';
import { clearTicketSnooze } from './ticket-snooze.js';
import { publishTicketChanged } from './pubby.js';
import { alertCronFailure } from './cron-jobs.js';

type SweepCursor = { at: string; id: string };
let sweepCursor: SweepCursor | null = null;

// One bounded sweep. Each ticket commits separately, so a bad record cannot
// roll back other wakeups. Multiple API instances may safely scan the same rows.
export async function processExpiredSnoozes(signal?: AbortSignal) {
  const sql = getDb();
  const scan = (cursor: SweepCursor | null) => sql`select id, workspace_id,
      to_char(snoozed_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as due_at
    from tickets where snoozed_until <= now() and deleted_at is null and merged_into_id is null
      and status_key in ('open', 'pending', 'escalated', 'gdpr')
      ${cursor ? sql`and (snoozed_until, id) > (${cursor.at}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
    order by snoozed_until, id limit 100`;
  let candidates = await scan(sweepCursor);
  if (!candidates.length && sweepCursor) { sweepCursor = null; candidates = await scan(null); }
  let processed = 0, failed = 0;
  const deadline = Date.now() + 30_000;
  for (const row of candidates) {
    if (signal?.aborted || Date.now() >= deadline) break;
    // Rotate past failed/locked rows too, so they cannot starve later tickets.
    // This cursor is only a scan hint; each mutation still verifies its row.
    sweepCursor = { at: row.due_at, id: row.id };
    try {
      const result = await sql.begin(async tx => {
        await tx`set local statement_timeout = '5s'`;
        return clearTicketSnooze(tx, { workspaceId: row.workspace_id, ticketId: row.id,
          automatic: true, actorId: null, skipLocked: true });
      });
      if (result?.activity.length) {
        processed++;
        // Sync polling also reads the committed state. Realtime delivery must
        // not hold up other wakeups or the worker's shutdown drain.
        void publishTicketChanged(row.workspace_id, row.id).catch(() => console.warn('[snooze-worker] realtime unavailable'));
      }
    } catch (error) {
      failed++;
      console.error('[snooze-worker] ticket failed', { workspaceId: row.workspace_id, ticketId: row.id,
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown' });
    }
  }
  if (candidates.length < 100 && sweepCursor?.id === candidates.at(-1)?.id) sweepCursor = null;
  return { processed, failed, scanned: candidates.length };
}

// The production Node entry owns this worker; importing the API for tests or
// serverless previews never starts it. No overlapping ticks in this process.
export function createSnoozeWorker(run = processExpiredSnoozes,
  report = (error: unknown) => alertCronFailure('snooze-expiry', error)) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  let controller = new AbortController();
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        const result = await run(controller.signal);
        if (result.processed) console.log('[snooze-worker]', JSON.stringify(result));
        if (result.failed) throw new Error(`${result.failed} snooze wakeups failed; they will be retried.`);
      } catch (error) {
        try { await report(error); }
        catch { console.error('[snooze-worker] failure reporting failed'); }
      }
    })().finally(() => { running = undefined; });
  };
  return {
    start(intervalMs = 60_000) {
      if (!stopped) return;
      stopped = false;
      controller = new AbortController();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick(); // Catch up immediately after startup or downtime.
    },
    async stop() {
      stopped = true;
      controller.abort();
      clearInterval(timer); timer = undefined;
      await running;
    },
  };
}

export const snoozeWorker = createSnoozeWorker();
