-- Advisory #14: tag slack_integrations with the Slack team_id so inbound-event
-- signature verification is an O(1) indexed lookup instead of an O(n) scan that
-- computes an HMAC against every workspace's signing_secret per request.
--
-- Nullable + lazily backfilled from the first verified event (no backfill job).
-- The index is NON-unique on purpose: backfill writes must never conflict, and
-- the HMAC signature check remains the real authority — team_id is only a
-- routing hint to pick the candidate row.
alter table slack_integrations add column if not exists team_id text;

create index if not exists slack_integrations_team_id_idx
  on slack_integrations (team_id)
  where team_id is not null;
