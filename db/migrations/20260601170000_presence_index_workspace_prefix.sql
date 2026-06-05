-- Follow-up to 20260601160000_generic_presence.sql responding to
-- Octopus review on PR #239.
--
-- The original index was `(entity_type, entity_id, last_seen_at desc)`.
-- Every WHERE clause that touches this table from the API also filters
-- on workspace_id (it's the tenant boundary), so leading with
-- workspace_id lets the planner pick this index on every roster query
-- rather than scanning all (entity_type, entity_id) rows across
-- workspaces and filtering after.
--
-- The original ticket_viewers index also lacked the workspace_id
-- prefix, but with one entity-type per table the cardinality gap was
-- small. With a generic table the gap widens — fixing it now before
-- the table grows.

drop index if exists presence_entity_seen_idx;

create index presence_entity_seen_idx
  on presence (workspace_id, entity_type, entity_id, last_seen_at desc);
