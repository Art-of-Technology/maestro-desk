-- Enable Row-Level Security on the portal customer-auth tables.
--
-- portal_magic_links and portal_sessions (added in 20260528170000_portal_auth.sql)
-- were created without RLS. Both have a bearer `token` primary key, so PostgREST
-- exposed them to the anon/authenticated roles via the project URL — anyone with
-- the URL could read/edit/delete them. The Supabase Security Advisor flagged this
-- as two CRITICAL findings:
--   • rls_disabled_in_public      (Table publicly accessible)
--   • sensitive_columns_exposed   (the `token` columns)
--
-- These tables are accessed ONLY by the API's service-role client
-- (api/src/routes/public.ts → supabaseAdmin, passed into api/src/lib/portal-auth.ts),
-- which bypasses RLS. Portal clients never query them directly — they carry the
-- session token as a bearer header to the API, which validates server-side.
--
-- So enabling RLS with NO policies is the correct fix: it denies all
-- anon/authenticated (PostgREST) access — closing both findings — while the
-- service-role API path is unaffected.

alter table public.portal_magic_links enable row level security;
alter table public.portal_sessions    enable row level security;
