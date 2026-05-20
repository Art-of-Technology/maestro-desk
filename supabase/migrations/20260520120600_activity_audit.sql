-- User-facing activity feed. Replaces both t.events[] (ticket-scoped events)
-- and the cross-entity aggregation in core/activity-log.js. Polymorphic on
-- (entity_type, entity_id) so a single query powers the Activity Log page.

create table events (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  entity_type     text not null check (entity_type in ('ticket','customer','workflow')),
  entity_id       uuid not null,
  kind            text not null,
  author_user_id  uuid references users(id) on delete set null,
  author_label    text not null,
  details         text not null,
  created_at      timestamptz not null default now()
);

create index on events (workspace_id, entity_type, entity_id, created_at desc);
create index on events (workspace_id, created_at desc);
create index on events (workspace_id, kind, created_at desc);

-- Security/compliance audit log — kept separate from the user-facing feed so
-- SOC2 evidence isn't co-mingled with day-to-day activity. Captures role
-- changes, exports, GDPR actions, auth events.

create table audit_events (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  actor_user_id   uuid references users(id) on delete set null,
  actor_ip        inet,
  actor_ua        text,
  action          text not null,
  target_type     text,
  target_id       uuid,
  metadata        jsonb,
  created_at      timestamptz not null default now()
);

create index on audit_events (workspace_id, created_at desc);
create index on audit_events (workspace_id, action, created_at desc);
create index on audit_events (workspace_id, actor_user_id, created_at desc)
  where actor_user_id is not null;
