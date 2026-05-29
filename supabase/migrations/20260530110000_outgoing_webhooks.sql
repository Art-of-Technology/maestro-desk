-- Outgoing webhooks. Workspaces register their own HTTP endpoints to
-- receive ticket-event POSTs (similar to GitHub webhooks). Distinct
-- from slack_integrations (which targets Slack's chat.postMessage)
-- in that this is generic — any URL, any receiver, signed with an
-- HMAC the workspace chose.
--
-- Multiple webhooks per workspace are supported (typical case: one
-- for a CRM, one for an analytics pipeline). Each subscribes to a
-- subset of the event taxonomy. The shared event keys are the same
-- as slack_integrations.events for now — keeps the trigger code in
-- tickets.ts simple.

create table workspace_webhooks (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references workspaces(id) on delete cascade,
  name                   text not null,
  url                    text not null,
  secret                 text not null,
  events                 text[] not null,
  active                 boolean not null default true,
  -- Telemetry from the most recent delivery attempt so the SPA can
  -- show a status indicator without us needing a separate delivery
  -- log. If we ever add a delivery_log table for retries / DLQ, this
  -- denormalised summary stays — it's cheap and answers the common
  -- "is this thing working" question in one row.
  last_delivery_at       timestamptz,
  last_delivery_status   int,
  last_delivery_error    text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index on workspace_webhooks (workspace_id);

create trigger set_updated_at before update on workspace_webhooks
  for each row execute function trigger_set_updated_at();

-- RLS aligned with the integrations-tables pattern (PR #201): JWT
-- workspace_ids gates reads/writes; platform admins see everything.
alter table workspace_webhooks enable row level security;

create policy workspace_webhooks_ws on workspace_webhooks
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());
