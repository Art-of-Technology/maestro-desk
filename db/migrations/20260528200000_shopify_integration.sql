-- Per-workspace Shopify integration. Stores the shop's myshopify
-- subdomain (e.g. "acme-store") and an admin API access token. Read
-- scopes on customers + orders are enough for the sidebar lookup.

create table shopify_integrations (
  workspace_id    uuid primary key references workspaces(id) on delete cascade,
  shop            text not null,
  access_token    text not null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger set_updated_at before update on shopify_integrations
  for each row execute function trigger_set_updated_at();
