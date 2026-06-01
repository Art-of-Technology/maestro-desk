-- Defense-in-depth: the original ticket_viewers_write policy let any
-- workspace member insert a row with any workspace_id they're a
-- member of, even if that workspace_id didn't match the actual
-- ticket's workspace. The API path is safe (we stamp workspace_id
-- from the auth context after a ticket-workspace lookup), but
-- direct PostgREST traffic could pollute the table with rows
-- pointing at tickets in other workspaces.
--
-- Tighten the with-check to require workspace_id = the ticket's
-- workspace_id. Add the same constraint to the using clause so a
-- correctly-inserted row can't later be UPDATEd with a stale or
-- forged workspace_id either.

alter policy ticket_viewers_write on ticket_viewers
  using (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and workspace_id = (select workspace_id from public.tickets where id = ticket_id)
  )
  with check (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
    and workspace_id = (select workspace_id from public.tickets where id = ticket_id)
  );
