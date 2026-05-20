-- Customers carry both a UUID PK and a workspace-scoped display_id ("M001")
-- so existing references in the codebase keep working.
-- erased_at is the GDPR null-PII marker; tickets keep referencing the customer
-- (with PII fields nulled) so the audit trail stays intact.

create table customers (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  display_id      text not null,
  first_name      text,
  last_name       text,
  username        text,
  email           citext,
  mobile          text,
  brand           text,
  vip_tier        text,
  jurisdiction    text,
  consent         boolean,
  kyc_status      text,
  since           date,
  backoffice_url  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  erased_at       timestamptz,
  unique (workspace_id, display_id)
);

create unique index customers_workspace_email_unique
  on customers (workspace_id, email)
  where deleted_at is null and erased_at is null and email is not null;

create index customers_workspace_active on customers (workspace_id)
  where deleted_at is null;

create trigger set_updated_at before update on customers
  for each row execute function trigger_set_updated_at();

create table customer_notes (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  author_user_id  uuid references users(id) on delete set null,
  text            text not null,
  created_at      timestamptz not null default now()
);

create index on customer_notes (customer_id, created_at desc);
