-- Custom fields are per-workspace, per-entity-type. Values are stored as text
-- and cast in the application layer (consistent with how the UI handles them).

create table custom_fields (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  entity_type     text not null check (entity_type in ('customer','ticket')),
  key             text not null,
  label           text not null,
  field_type      text not null check (field_type in ('text','number','date','select','multiselect','boolean')),
  options         jsonb,
  required        boolean not null default false,
  default_value   text,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, entity_type, key)
);

create trigger set_updated_at before update on custom_fields
  for each row execute function trigger_set_updated_at();

create table custom_field_values (
  workspace_id    uuid not null,
  field_id        uuid not null references custom_fields(id) on delete cascade,
  entity_type     text not null,
  entity_id       uuid not null,
  value           text,
  updated_at      timestamptz not null default now(),
  primary key (field_id, entity_id)
);

create index on custom_field_values (entity_type, entity_id);

create trigger set_updated_at before update on custom_field_values
  for each row execute function trigger_set_updated_at();
