-- tickets.resolved_at was never written by the API (only the demo seed set
-- it) even though the data-retention purge and, now, the SLA breach report
-- both key off it. The API now stamps it on every resolve transition; this
-- backfills history using updated_at — the best available approximation
-- (>= the true resolve time, so retention windows and SLA resolution times
-- err on the conservative/long side).
--
-- NOTE: backfilling makes long-resolved tickets visible to the retention
-- purge cron for the first time. Default retention is 5 years, so nothing
-- becomes purge-eligible today, but workspaces with short custom windows
-- will start purging as configured.
update tickets
set resolved_at = updated_at
where status_key = 'resolved' and resolved_at is null;

-- Partial indexes for the SLA breach report's per-ticket laterals (first
-- customer message / first agent reply). Without these the lateral walks
-- the ticket's (ticket_id, created_at) index entries fetching heap tuples
-- until one passes the role filter — O(thread length) per ticket.
create index if not exists ticket_messages_first_customer_idx
  on ticket_messages (ticket_id, created_at)
  where role = 'customer' and deleted_at is null and merged_from_id is null;

create index if not exists ticket_messages_first_reply_idx
  on ticket_messages (ticket_id, created_at)
  where role in ('agent', 'ai') and deleted_at is null and merged_from_id is null;
