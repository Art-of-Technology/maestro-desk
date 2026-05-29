-- Admin-only UPDATE/DELETE policy on workspace_members so agents.ts
-- PATCH/DELETE can flip to the user-scoped client.
--
-- Up to now workspace_members had only a SELECT policy
-- (workspace_members_visible). Writes were possible only via
-- service-role, which meant the API had no DB-level guard against a
-- regular agent rewriting another agent's role_id or removing them
-- entirely. The legacy gap was hidden because the only writers were
-- god-mode + agents.ts running as service-role.
--
-- New policy:
--   - UPDATE/DELETE allowed iff the caller is admin in the SAME
--     workspace as the row being modified, OR a platform admin.
--   - INSERT is intentionally NOT covered yet — adding agents is a
--     separate flow (invite + provisioning) handled by god routes
--     today, all still on service-role.

-- Helper: "is the caller admin in workspace X". SECURITY DEFINER
-- because the body reads workspace_members + roles, which themselves
-- have RLS — without DEFINER the policy would recurse on itself.
create or replace function public.is_workspace_admin(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
    from workspace_members wm
    join roles r on r.id = wm.role_id
    where wm.user_id = auth.uid()
      and wm.workspace_id = ws
      and wm.active = true
      and r.is_admin = true
  );
$$;

grant execute on function public.is_workspace_admin(uuid) to authenticated;

create policy workspace_members_admin_update on workspace_members
  for update to authenticated
  using      (public.is_workspace_admin(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_admin(workspace_id) or public.is_platform_admin_jwt());

create policy workspace_members_admin_delete on workspace_members
  for delete to authenticated
  using (public.is_workspace_admin(workspace_id) or public.is_platform_admin_jwt());
