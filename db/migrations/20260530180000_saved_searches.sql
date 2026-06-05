-- Per-user saved searches on the ticket list. Each row captures a
-- named combination of the ticket-list filter state (status,
-- category, priority, agent, sentiment, view, query) so an agent
-- can rebuild their working queue in one click instead of restoring
-- six dropdowns by hand.
--
-- Per-user (not workspace-shared) is the natural v1: agents have
-- different queues. A future "share with workspace" flag would
-- promote a search to a workspace-level view chip.

create table saved_searches (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  filters      jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index saved_searches_user_idx
  on saved_searches (workspace_id, user_id, created_at desc);

-- Prevent the same agent from creating two searches with identical
-- names in the same workspace — keeps the picker dropdown unambiguous.
create unique index saved_searches_name_unique
  on saved_searches (workspace_id, user_id, lower(name));

create trigger set_updated_at before update on saved_searches
  for each row execute function trigger_set_updated_at();
