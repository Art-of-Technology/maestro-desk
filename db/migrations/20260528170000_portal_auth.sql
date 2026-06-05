-- Portal customer authentication tables. Two-step: request → magic link
-- emailed → click → /verify exchanges for a long-lived session token.
--
-- portal_magic_links is one-time use (used_at != null = consumed).
-- portal_sessions is the long-lived token clients carry as a bearer header.

create table portal_magic_links (
  token           text primary key,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index on portal_magic_links (customer_id, created_at desc);

create table portal_sessions (
  token           text primary key,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);

create index on portal_sessions (workspace_id, customer_id);
