-- Idempotent role-creation guard for the `service_role` role — the earlier
-- RLS migration set up `anon` and `authenticated` guards but missed
-- service_role, which the grants below assume. No-op on real Supabase
-- (service_role is pre-created); only fires for local PG validation.
do $$ begin
  create role service_role nologin bypassrls;
exception when duplicate_object then null;
end $$;

-- Postgres-level GRANTs for the Supabase-managed roles.
--
-- Discovered necessary 2026-05-21 when the test script hit "permission denied
-- for table users" with the service_role key. New Supabase projects don't
-- auto-grant table permissions on objects created via migration — the
-- migration apply runs as `postgres` and tables are owned by `postgres`,
-- so service_role / authenticated / anon get nothing by default.
--
-- Layering:
--   service_role  : full bypass-RLS access (used by the API server)
--   authenticated : full access, gated by RLS policies (direct browser → PostgREST)
--   anon          : no table access by default (RLS would deny anyway)
--
-- ALTER DEFAULT PRIVILEGES at the end makes any future table created in this
-- schema by `postgres` auto-grant to these roles — so we don't have to repeat
-- this dance on every schema change.

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables    in schema public to authenticated, service_role;
grant all on all sequences in schema public to authenticated, service_role;
grant all on all functions in schema public to authenticated, service_role;

alter default privileges in schema public
  grant all on tables to authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to authenticated, service_role;
alter default privileges in schema public
  grant all on functions to authenticated, service_role;
