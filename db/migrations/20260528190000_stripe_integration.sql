-- Per-workspace Stripe integration. The api_key is a restricted Stripe
-- key (read-only on customers + subscriptions + charges is enough).
-- One row per workspace via the PK constraint.

create table stripe_integrations (
  workspace_id    uuid primary key references workspaces(id) on delete cascade,
  api_key         text not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger set_updated_at before update on stripe_integrations
  for each row execute function trigger_set_updated_at();
