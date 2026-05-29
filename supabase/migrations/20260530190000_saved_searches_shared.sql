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

-- RLS expansion: keep the owner-only write policy in place and add
-- a permissive SELECT policy for workspace members on shared rows.
-- Drop + recreate the existing combined policy so SELECT is widened
-- without weakening writes.

drop policy if exists saved_searches_owner on saved_searches;

create policy saved_searches_owner_write on saved_searches
  for all to authenticated
  using      (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy saved_searches_shared_read on saved_searches
  for select to authenticated
  using (is_shared = true and public.is_workspace_member(workspace_id));
