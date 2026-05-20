-- Server-side replacements for the per-user localStorage keys.
-- Was: localStorage.getItem('draft:<ticketId>:<tab>')
-- Now: keyed (user_id, ticket_id, compose_tab) so drafts follow the user across devices.

create table message_drafts (
  workspace_id    uuid not null,
  user_id         uuid not null references users(id) on delete cascade,
  ticket_id       uuid not null references tickets(id) on delete cascade,
  compose_tab     text not null check (compose_tab in ('reply','note')),
  body            text not null,
  updated_at      timestamptz not null default now(),
  primary key (user_id, ticket_id, compose_tab)
);

create trigger set_updated_at before update on message_drafts
  for each row execute function trigger_set_updated_at();

-- Was: localStorage keys 'notif_prefs', 'theme', 'agent_preferred_lang',
--      'collapsed_sections', dashboard layout, report layout.
-- Per-workspace because the same human can have different prefs in different
-- workspaces.
create table user_preferences (
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  theme           text,
  preferred_lang  text,
  notif_prefs     jsonb,
  dashboard_layout jsonb,
  report_layout   jsonb,
  collapsed_sections jsonb,
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create trigger set_updated_at before update on user_preferences
  for each row execute function trigger_set_updated_at();

-- Was: the in-memory NOTIFICATIONS_READ / NOTIFICATIONS_DISMISSED sets in
-- notifications/index.js that reset on page reload.
create table notification_state (
  workspace_id    uuid not null,
  user_id         uuid not null references users(id) on delete cascade,
  notif_key       text not null,
  read_at         timestamptz,
  dismissed_at    timestamptz,
  primary key (user_id, notif_key)
);

create index on notification_state (user_id, read_at)
  where read_at is null;
