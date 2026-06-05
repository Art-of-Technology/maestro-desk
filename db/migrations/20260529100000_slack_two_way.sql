-- Slack two-way sync. Extends slack_integrations with the bot-token
-- credentials needed to use chat.postMessage (so we can capture the
-- thread_ts) and the signing_secret needed to verify inbound Slack
-- event POSTs. Both are nullable — workspaces that only want outbound
-- notifications keep working with just webhook_url.

alter table slack_integrations
  add column bot_token      text,
  add column signing_secret text;

-- One row per Slack thread we're tracking. The PK lets us look up
-- "what ticket is this thread tied to" in O(1) when an inbound event
-- arrives; the unique on (workspace_id, ticket_id) keeps us from
-- accidentally spawning two threads per ticket on retry.

create table slack_thread_mappings (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  ticket_id     uuid not null references tickets(id) on delete cascade,
  channel_id    text not null,
  thread_ts     text not null,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, channel_id, thread_ts),
  unique (workspace_id, ticket_id)
);

create index on slack_thread_mappings (ticket_id);
