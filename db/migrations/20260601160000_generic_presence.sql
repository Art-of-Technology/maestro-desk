-- Generic presence — extend the per-ticket viewer-roster pattern from
-- PRs #236/#237 to arbitrary entity types (tickets today; customers,
-- KB articles, dashboards, etc. tomorrow). One table replaces what
-- would otherwise become N near-identical _viewers tables.
--
-- Keyed by (workspace_id, entity_type, entity_id, user_id) so the
-- same agent can hold presence on a customer and a ticket
-- simultaneously without colliding.
--
-- Trade-offs vs the dedicated ticket_viewers it replaces:
--   - FK on entity_id is gone (can't reference different parent
--     tables from one column). Hard-delete cascade cleanup is lost;
--     stale rows age out of reads in 15s anyway, and a periodic
--     purge can prune cold ones if it ever matters.
--   - The "workspace_id must match the ticket's workspace_id"
--     defense-in-depth predicate from PR #237's RLS tightening
--     would need a per-entity case-when in the policy or a polymorphic
--     trigger. Skipped for v1 — the API layer (Hono routes) is the
--     trusted writer and stamps workspace_id from auth context after
--     looking up the entity. If direct PostgREST traffic ever lands
--     for presence, add the trigger then.

create table presence (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type  text not null,
  entity_id    uuid not null,
  user_id      uuid not null references users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  composing    boolean not null default false,
  composing_at timestamptz,
  primary key (workspace_id, entity_type, entity_id, user_id)
);

create index presence_entity_seen_idx
  on presence (entity_type, entity_id, last_seen_at desc);

-- Carry forward whatever rows are live in ticket_viewers so agents
-- currently viewing tickets don't see their chips blink off during
-- deploy. With the 15s read window this would self-heal on the next
-- heartbeat regardless; the copy just makes it instant.
insert into presence (workspace_id, entity_type, entity_id, user_id, last_seen_at, composing, composing_at)
  select workspace_id, 'ticket', ticket_id, user_id, last_seen_at, composing, composing_at
  from ticket_viewers
on conflict do nothing;

drop table ticket_viewers cascade;
