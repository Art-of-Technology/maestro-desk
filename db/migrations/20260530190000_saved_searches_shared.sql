-- Workspace-shared saved searches. An agent can promote their own
-- search to be visible to everyone in the workspace — useful for
-- team-wide queues like "Triage" or "Tier-2 escalations" that the
-- whole team should land on.
--
-- Ownership stays with the author: only the owner can edit or
-- delete a shared search, and only the owner can flip is_shared.
-- Non-owner readers see it in their dropdown but the manage UI
-- hides the delete button for them.

alter table saved_searches
  add column is_shared boolean not null default false;

-- Index supports the SPA's GET pattern: "show me my own searches
-- + every shared one in this workspace."
create index saved_searches_shared_idx
  on saved_searches (workspace_id)
  where is_shared = true;
