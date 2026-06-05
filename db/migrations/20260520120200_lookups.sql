-- Per-workspace lookups for status / priority / category. Lets each tenant
-- rename, add, reorder, or retire values without schema migrations.
-- The (workspace_id, key) composite is referenced by tickets via FK below.

create table ticket_statuses (
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  key             text not null,
  label           text not null,
  color           text,
  sort_order      int not null default 0,
  is_terminal     boolean not null default false,
  primary key (workspace_id, key)
);

create table ticket_priorities (
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  key             text not null,
  label           text not null,
  sort_order      int not null default 0,
  primary key (workspace_id, key)
);

create table ticket_categories (
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  key             text not null,
  label           text not null,
  primary key (workspace_id, key)
);
