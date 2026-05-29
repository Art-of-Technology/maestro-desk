-- Custom Access Token Hook: injects workspace membership + platform-admin
-- claims into every issued JWT so RLS policies can read them via
-- request.jwt.claims.
--
-- Why we need this: RLS helpers like public.current_workspace_id()
-- already read from JWT claims, but Supabase doesn't put workspace_id
-- (or workspace memberships, or is_platform_admin) in the JWT by
-- default. Without this hook, the only way for RLS to scope reads is
-- to look up workspace_members on every query — slow and circular.
--
-- Claims injected:
--   workspace_ids        : text[]  — every active workspace the user belongs to
--   is_platform_admin    : boolean — mirrors public.users.is_platform_admin
--
-- We deliberately do NOT inject a single "active workspace_id" claim
-- here: the user's currently-selected workspace is session state, not
-- a property of the user. The API will continue to use the
-- X-Workspace-Id header for that selection, and RLS policies should
-- check the active workspace against the workspace_ids array (a
-- follow-up migration will introduce a public.is_workspace_member()
-- helper for that).
--
-- HOW TO ENABLE (one-time, per environment):
--   Supabase Dashboard → Authentication → Hooks → Custom Access Token
--   → set to "public.custom_access_token_hook"
--   → enable
-- Once enabled, every newly-issued token will carry the claims. Users
-- already signed in need a token refresh (sign out/in, or the SPA
-- refresh path) to pick up the new claims.
--
-- Verifying it's working: GET /api/v1/whoami/claims (added in this
-- PR) decodes the caller's JWT and returns the payload — workspace_ids
-- and is_platform_admin should appear once the hook is enabled.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
-- Hook runs as the auth service principal, so we set search_path
-- explicitly to avoid relying on the caller's path.
set search_path = public, pg_catalog
as $$
declare
  user_id           uuid := (event ->> 'user_id')::uuid;
  claims            jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  workspaces        text[];
  platform_admin    boolean;
begin
  -- Active workspace memberships only — suspended/deleted memberships
  -- don't grant access, so they don't belong in the JWT.
  select array_agg(workspace_id::text)
    into workspaces
    from workspace_members
    where user_id = custom_access_token_hook.user_id
      and active = true;

  select coalesce(is_platform_admin, false)
    into platform_admin
    from users
    where id = user_id;

  claims := claims
    || jsonb_build_object(
         'workspace_ids',     coalesce(to_jsonb(workspaces), '[]'::jsonb),
         'is_platform_admin', coalesce(platform_admin, false)
       );

  return jsonb_build_object('claims', claims);
end;
$$;

-- Grant the auth admin role permission to call the hook. Without this,
-- Supabase Auth raises "permission denied" when token issuance tries to
-- invoke the function. (The grant doesn't expose it to end users — only
-- to the auth.users-issuing principal.)
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;

-- Read access on the two tables the hook needs. The hook function is
-- SECURITY DEFINER so it runs as its owner, but explicit grants make
-- the intent clear and let us audit the surface from the auth-admin
-- side without surprises.
grant select on public.workspace_members to supabase_auth_admin;
grant select on public.users             to supabase_auth_admin;
