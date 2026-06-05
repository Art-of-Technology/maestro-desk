-- Platform admin (the "God user") — super-user role above workspaces.
--
-- Used by the platform operator to manage all brands, view all data, and
-- provision new white-label tenants. Source of truth is a single boolean on
-- public.users; RLS policies on every workspace-scoped table gain an
-- `OR public.is_platform_admin()` escape hatch in the companion migration
-- (20260522140100_platform_admin_rls.sql).
--
-- Why a flag on users (vs. separate platform_admins table):
--   - Membership semantics already live there (workspace_members is per-
--     workspace; platform admin is global). One column = one source of truth.
--   - Granting / revoking is a simple UPDATE. Audit lives in events / audit_events.
--
-- Why security definer on is_platform_admin():
--   - Called from RLS policies. The function reads public.users which itself
--     has RLS — without security definer, evaluating a policy on table X that
--     consults is_platform_admin() could recurse into RLS on public.users
--     (users_self_select would let it through, but only just). Definer +
--     locked search_path makes it unconditional and side-steps the recursion
--     risk entirely. Same shape as public.current_workspace_id().
--
-- The function returns false for unauthenticated callers (auth.uid() = null),
-- so anon + service_role both evaluate to false — only a logged-in user whose
-- users row has the flag set returns true.

alter table public.users
  add column if not exists is_platform_admin boolean not null default false;
