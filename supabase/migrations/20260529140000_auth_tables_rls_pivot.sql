-- Pivot users / workspace_members / roles RLS from the legacy
-- current_workspace_id() helper to is_workspace_member(). Required
-- before tickets.ts can move to the user-scoped Supabase client —
-- those routes do peer lookups on these three tables (assignee
-- name, membership for admin checks, role.is_admin embed) and the
-- legacy policies would return zero rows under sbUser because the
-- single-workspace_id claim isn't injected.
--
-- Semantics drift: the legacy policies scoped visibility to ONE
-- active workspace (current_workspace_id). The new policies scope
-- to ANY workspace the user belongs to (workspace_ids array). The
-- API still scopes its queries by the active X-Workspace-Id, so
-- end-user behaviour is unchanged — RLS just becomes broader as
-- defense-in-depth rather than the sole gate.

-- ─── users ─────────────────────────────────────────────────────────────
-- users_self_select / users_self_update are unchanged (id = auth.uid()).
-- Replace users_workspace_peer_select with a JWT-driven variant.

drop policy if exists users_workspace_peer_select on users;

create policy users_workspace_peer_select on users
  for select to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.user_id = users.id
        and wm.active = true
        and public.is_workspace_member(wm.workspace_id)
    )
  );

-- ─── workspace_members ─────────────────────────────────────────────────

drop policy if exists workspace_members_visible on workspace_members;

create policy workspace_members_visible on workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- ─── roles ─────────────────────────────────────────────────────────────

drop policy if exists roles_workspace_access on roles;

create policy roles_workspace_access on roles
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());
