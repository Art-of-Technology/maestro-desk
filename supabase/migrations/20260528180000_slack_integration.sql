-- Per-workspace Slack incoming-webhook integration. One integration per
-- workspace (workspace_id is the PK) — admins can plug in a single Slack
-- channel for outbound notifications. The events array gates which
-- server-side ticket events trigger a post.
--
-- The webhook URL is the secret — Slack incoming-webhook URLs are
-- bearer-like (anyone with the URL can post). Treated as plaintext in
-- the DB; rotate the URL via Slack if compromised.

create table slack_integrations (
  workspace_id    uuid primary key references workspaces(id) on delete cascade,
  webhook_url     text not null,
  channel         text,
  active          boolean not null default true,
  events          text[] not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger set_updated_at before update on slack_integrations
  for each row execute function trigger_set_updated_at();
