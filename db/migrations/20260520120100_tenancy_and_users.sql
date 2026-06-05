-- Workspaces are the tenant boundary. Every domain row carries workspace_id.
create table workspaces (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  plan            text not null default 'trial',
  ai_credits_micro bigint not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create trigger set_updated_at before update on workspaces
  for each row execute function trigger_set_updated_at();

-- Users are global identities. A user joins one or more workspaces via workspace_members.
create table users (
  id              uuid primary key default gen_random_uuid(),
  email           citext not null unique,
  name            text not null,
  initials        text,
  password_hash   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create trigger set_updated_at before update on users
  for each row execute function trigger_set_updated_at();

-- Global permission registry. Same keys used in data.js PERMISSIONS today.
create table permissions (
  key             text primary key,
  label           text not null
);

insert into permissions (key, label) values
  ('tickets',   'Tickets'),
  ('customers', 'Customers'),
  ('reports',   'Reports'),
  ('ai',        'AI Intelligence'),
  ('workflows', 'Workflows'),
  ('tags',      'Tags'),
  ('roles',     'Roles & Perms'),
  ('gdpr',      'GDPR Actions');

-- Roles are per-workspace so each tenant can name/structure their own.
-- is_admin marks the protected role that can't be deleted or stripped.
create table roles (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  name            text not null,
  is_admin        boolean not null default false,
  unique (workspace_id, name)
);

create table role_permissions (
  role_id         uuid not null references roles(id) on delete cascade,
  permission_key  text not null references permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

-- Membership row carries the (user, workspace, role) triple plus OOO data
-- previously held in AGENTS row (oooFrom, oooTo, oooNote).
create table workspace_members (
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  role_id         uuid not null references roles(id),
  active          boolean not null default true,
  ooo_from        date,
  ooo_to          date,
  ooo_note        text,
  joined_at       timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index on workspace_members (user_id);
create index on workspace_members (role_id);
