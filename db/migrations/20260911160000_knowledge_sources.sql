create table knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  article_id uuid references kb_articles(id) on delete set null,
  kind text not null check (kind in ('url', 'file')),
  title text not null,
  category text not null default 'General',
  language text not null default 'en',
  jurisdiction text not null default '',
  locator text not null,
  fingerprint text not null,
  storage_key text,
  auto_refresh boolean not null default false,
  checked_at timestamptz,
  next_check_at timestamptz,
  error text,
  lease_until timestamptz,
  approved_version_id uuid,
  latest_version_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(workspace_id, fingerprint)
);
create table knowledge_source_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_id uuid not null references knowledge_sources(id) on delete cascade,
  content_hash text not null,
  body text not null,
  warnings jsonb not null default '[]',
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references users(id) on delete set null,
  unique(source_id, content_hash)
);
create index knowledge_refresh_due on knowledge_sources(next_check_at) where auto_refresh;
create index knowledge_versions_source on knowledge_source_versions(workspace_id, source_id, created_at desc);

-- A workspace deletion must not orphan private source files.
create function enqueue_knowledge_file_delete() returns trigger language plpgsql as $$
begin
  if old.storage_key is not null then
    insert into pending_object_deletions(storage_key, reason) values(old.storage_key, 'orphan')
    on conflict(storage_key) do nothing;
  end if;
  return old;
end $$;
create trigger knowledge_file_delete before delete on knowledge_sources
for each row execute function enqueue_knowledge_file_delete();
