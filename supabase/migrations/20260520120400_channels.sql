-- Channels are the ingress configurations (email inbox, web form, chat widget,
-- API, etc). Created before tickets because tickets reference channel_id.
-- inbox_messages.converted_ticket_id FK to tickets is added in the next
-- migration (after tickets exists).

create table channels (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  display_id      text not null,
  name            text not null,
  type            text not null,
  address         text,
  status          text not null default 'active',
  default_category_key text,
  default_assigned_user_id uuid references users(id) on delete set null,
  signature       text,
  config          jsonb,
  volume_30d      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, display_id),
  foreign key (workspace_id, default_category_key)
    references ticket_categories (workspace_id, key)
    on delete set null
);

create trigger set_updated_at before update on channels
  for each row execute function trigger_set_updated_at();

-- Raw inbound messages awaiting triage / conversion to a ticket.
-- external_id deduplicates against provider message IDs (Postmark, IMAP UID).
create table inbox_messages (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  channel_id      uuid not null references channels(id) on delete cascade,
  external_id     text,
  from_name       text,
  from_email      citext,
  subject         text,
  body            text,
  body_html       text,
  received_at     timestamptz not null,
  status          text not null default 'new',
  converted_ticket_id uuid,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  unique (channel_id, external_id)
);

create index on inbox_messages (workspace_id, status, received_at desc);
