-- Was: BUSINESS_HOURS in tickets/sla.js, mutated in core/business-hours.js,
-- in-memory only. Per-workspace because each tenant runs different hours.
create table business_hours (
  workspace_id    uuid primary key references workspaces(id) on delete cascade,
  enabled         boolean not null default true,
  days            jsonb not null,
  holidays        date[] not null default '{}',
  updated_at      timestamptz not null default now()
);

create trigger set_updated_at before update on business_hours
  for each row execute function trigger_set_updated_at();

-- Was: localStorage 'webhooks' key in js/webhooks/index.js.
-- secret is HMAC-SHA256 signing key sent with every outbound delivery.
create table webhooks (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  url             text not null,
  events          text[] not null,
  status          text not null default 'active' check (status in ('active','inactive')),
  secret          text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger set_updated_at before update on webhooks
  for each row execute function trigger_set_updated_at();

-- Delivery log lets us retry, debug, and surface to the user which webhooks
-- failed. Currently the UI shows the latest payload from localStorage; this
-- table is the real source of truth.
create table webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  webhook_id      uuid not null references webhooks(id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  response_code   int,
  response_body   text,
  attempt         int not null default 1,
  succeeded       boolean,
  created_at      timestamptz not null default now()
);

create index on webhook_deliveries (webhook_id, created_at desc);
create index on webhook_deliveries (workspace_id, succeeded, created_at desc);
