-- Extend the single-shot CSAT reminder (PR #220) to a cadenced
-- schedule. A new int column tracks how many reminders have fired
-- so the worker can step through {3d, 7d, 14d} thresholds and stop
-- when the cap is hit.
--
-- Backfill: rows where csat_last_reminded_at is already non-null
-- have had one reminder under the v1 flow — count them as 1 so the
-- worker doesn't double-send.

alter table tickets
  add column csat_reminder_count int not null default 0;

update tickets
   set csat_reminder_count = 1
 where csat_last_reminded_at is not null;

-- Drop the v1 partial index (which assumed last_reminded_at IS NULL
-- meant eligible) and rebuild a broader one keyed off the cadence
-- gate: count < 3 AND not yet rated.

drop index if exists tickets_csat_pending_reminder_idx;

create index tickets_csat_pending_reminder_idx
  on tickets (csat_requested_at)
  where csat_submitted_at is null
    and csat_requested_at is not null
    and csat_reminder_count < 3;
