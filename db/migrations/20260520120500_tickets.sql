-- Tickets — the core entity. Carries display_id ("TK-001") for UI continuity.
-- All status/priority/category references go via the per-workspace lookup tables.
-- version supports optimistic locking when multiple agents edit the same ticket.

create table tickets (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  display_id        text not null,
  subject           text not null,
  customer_id       uuid not null references customers(id),
  status_key        text not null,
  priority_key      text not null,
  category_key      text,
  assigned_user_id  uuid references users(id) on delete set null,
  channel_id        uuid references channels(id) on delete set null,
  source_inbox_id   uuid references inbox_messages(id) on delete set null,
  sla_state         text,
  csat_score        smallint check (csat_score between 1 and 5),
  csat_stars        smallint,
  csat_comment      text,
  csat_requested_at timestamptz,
  csat_submitted_at timestamptz,
  snoozed_until     timestamptz,
  snoozed_at        timestamptz,
  snoozed_by_user_id uuid references users(id) on delete set null,
  snooze_reason     text,
  snooze_woken_at   timestamptz,
  merged_into_id    uuid references tickets(id) on delete set null,
  merged_at         timestamptz,
  status_before_merge text,
  version           int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  deleted_at        timestamptz,
  unique (workspace_id, display_id),
  foreign key (workspace_id, status_key)
    references ticket_statuses (workspace_id, key),
  foreign key (workspace_id, priority_key)
    references ticket_priorities (workspace_id, key),
  foreign key (workspace_id, category_key)
    references ticket_categories (workspace_id, key)
);

create index on tickets (workspace_id, status_key) where deleted_at is null;
create index on tickets (workspace_id, assigned_user_id) where deleted_at is null;
create index on tickets (workspace_id, customer_id) where deleted_at is null;
create index on tickets (workspace_id, updated_at desc) where deleted_at is null;
create index on tickets (workspace_id, sla_state) where deleted_at is null;

create trigger set_updated_at before update on tickets
  for each row execute function trigger_set_updated_at();

-- Now that tickets exists, close the FK loop on inbox_messages.
alter table inbox_messages
  add constraint inbox_messages_converted_ticket_fk
  foreign key (converted_ticket_id) references tickets(id) on delete set null;

-- Each message in a ticket thread. role: customer | agent | ai | note | system.
-- mentions[] holds user UUIDs of agents @-mentioned in an internal note.
create table ticket_messages (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  ticket_id       uuid not null references tickets(id) on delete cascade,
  role            text not null check (role in ('customer','agent','ai','note','system')),
  author_user_id  uuid references users(id) on delete set null,
  author_label    text not null,
  body            text not null,
  mentions        uuid[] not null default '{}',
  merged_from_id  uuid references tickets(id) on delete set null,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index on ticket_messages (ticket_id, created_at);
create index on ticket_messages (workspace_id, created_at desc) where deleted_at is null;

create table ticket_attachments (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  ticket_id       uuid not null references tickets(id) on delete cascade,
  message_id      uuid references ticket_messages(id) on delete set null,
  filename        text not null,
  size_bytes      bigint,
  storage_key     text not null,
  mime_type       text,
  uploaded_by_user_id uuid references users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index on ticket_attachments (ticket_id, created_at);

-- Bidirectional link between two tickets. Canonicalised so each pair is one row.
create table ticket_links (
  workspace_id    uuid not null,
  a_id            uuid not null references tickets(id) on delete cascade,
  b_id            uuid not null references tickets(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (a_id, b_id),
  check (a_id < b_id)
);

create index on ticket_links (b_id);

-- Manual tags applied by agents.
create table ticket_tags (
  workspace_id    uuid not null,
  ticket_id       uuid not null references tickets(id) on delete cascade,
  tag             text not null,
  primary key (ticket_id, tag)
);

create index on ticket_tags (workspace_id, tag);

-- AI-suggested tags with confidence + accepted flag.
create table ticket_ai_tags (
  workspace_id    uuid not null,
  ticket_id       uuid not null references tickets(id) on delete cascade,
  tag             text not null,
  confidence      smallint not null check (confidence between 0 and 100),
  accepted        boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (ticket_id, tag)
);

create index on ticket_ai_tags (workspace_id, tag);

-- Per-workspace tag library — drives the Tags page counts + AI vs manual split.
create table tag_library (
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  tag             text not null,
  kind            text not null check (kind in ('manual','ai')),
  ai_confidence   smallint,
  primary key (workspace_id, tag)
);

-- Time entries on tickets — roll up to per-agent totals and reports.
create table time_entries (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  ticket_id       uuid not null references tickets(id) on delete cascade,
  user_id         uuid not null references users(id) on delete set null,
  minutes         int not null check (minutes > 0),
  note            text,
  billable        boolean not null default true,
  created_at      timestamptz not null default now()
);

create index on time_entries (ticket_id, created_at desc);
create index on time_entries (workspace_id, user_id);
