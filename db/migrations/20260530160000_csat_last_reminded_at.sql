-- Tracks the last time a CSAT reminder was sent for a ticket. v1 only
-- supports a single reminder per ticket (~3 days after the initial
-- request), so this doubles as a "reminded yet?" flag — non-null means
-- "we already chased once, don't chase again."
--
-- A future PR can add a max-reminder count or a configurable cadence
-- without changing the column shape.

alter table tickets
  add column csat_last_reminded_at timestamptz;

-- Partial index supports the worker's recurring scan: "open survey
-- requests that haven't been chased yet and are older than the
-- threshold." We don't put the threshold in the predicate — the
-- worker passes it at query time.
create index tickets_csat_pending_reminder_idx
  on tickets (csat_requested_at)
  where csat_submitted_at is null
    and csat_last_reminded_at is null
    and csat_requested_at is not null;
