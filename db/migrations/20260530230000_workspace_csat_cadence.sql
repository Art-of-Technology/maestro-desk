-- Per-workspace CSAT reminder cadence. The hardcoded [3, 7, 14] from
-- PR #229 moves into a configurable column so workspaces with
-- different customer-response patterns can tune it.
--
-- Defaults to the existing hardcoded schedule so behaviour is
-- unchanged for every existing workspace. Setting the column to an
-- empty array disables reminders entirely.
--
-- The CHECK constraint guards length only. Per-element bounds
-- (1..365 days, strictly ascending) live in app code (workspace.ts
-- PATCH validation) because CHECK constraints can't run subqueries
-- against unnest(), which we'd need to express either rule.

alter table workspaces
  add column csat_reminder_days int[] not null default array[3, 7, 14];

alter table workspaces
  add constraint csat_reminder_days_length check (
    array_length(csat_reminder_days, 1) is null
    or array_length(csat_reminder_days, 1) between 1 and 6
  );
