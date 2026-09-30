create table workspace_macros (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  display_id text not null default ('MAC-' || substr(gen_random_uuid()::text, 1, 8)),
  name text not null,
  icon text not null default '⚡',
  description text not null default '',
  actions jsonb not null check (jsonb_typeof(actions) = 'array'),
  usage_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (workspace_id, display_id)
);
