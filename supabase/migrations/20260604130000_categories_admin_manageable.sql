-- Make ticket_categories admin-manageable: add an is_active toggle and tighten
-- writes to workspace admins.
--
-- Until now categories were a fixed lookup seeded at provision time, and the
-- single `ticket_categories_ws` policy let ANY authenticated workspace member
-- INSERT/UPDATE/DELETE them. This migration:
--   1. adds `is_active boolean default true` so a default category can be
--      disabled (hidden from new tickets + AI triage) without losing history;
--   2. replaces the catch-all policy with read-for-members + write-for-admins,
--      matching the workspace_members admin-write pattern
--      (20260529230000_workspace_members_admin_writes.sql).
--
-- No DELETE path is exposed in the API — disabling (is_active=false) is the
-- reversible, history-safe way to retire a category. Existing tickets keep
-- their category_key regardless.

alter table ticket_categories
  add column if not exists is_active boolean not null default true;

-- Read for any workspace member; writes for workspace admins (or platform
-- admins). Drop the old all-verbs member policy first.
drop policy if exists ticket_categories_ws on ticket_categories;

create policy ticket_categories_select on ticket_categories
  for select to authenticated
  using (
    workspace_id = public.current_workspace_id()
    or public.is_platform_admin_jwt()
  );

create policy ticket_categories_admin_write on ticket_categories
  for all to authenticated
  using (
    (workspace_id = public.current_workspace_id() and public.is_workspace_admin(workspace_id))
    or public.is_platform_admin_jwt()
  )
  with check (
    (workspace_id = public.current_workspace_id() and public.is_workspace_admin(workspace_id))
    or public.is_platform_admin_jwt()
  );
