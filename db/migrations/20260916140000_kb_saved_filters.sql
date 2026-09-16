create table kb_saved_filters (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  filters jsonb not null check (jsonb_typeof(filters) = 'object'),
  created_at timestamptz not null default now()
);
create unique index kb_saved_filters_name_unique
  on kb_saved_filters(workspace_id, user_id, lower(name));

-- Keep transfer receipts after deletion: an old browser must not resurrect a filter.
create table kb_filter_transfers (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  source_id text not null check (length(source_id) between 1 and 100),
  primary key (workspace_id, user_id, source_id)
);
