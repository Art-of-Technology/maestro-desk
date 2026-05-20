-- Extensions
create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- updated_at trigger helper used by every table that tracks modifications
create or replace function trigger_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Helper used by RLS policies to read the active workspace from the JWT.
-- The API sets a custom claim `workspace_id` on sign-in / workspace-switch.
-- Returns NULL when no JWT or no claim (which causes RLS to deny by default).
-- Lives in public (not auth — Supabase owns that schema). Stable so PG can
-- inline-evaluate it per query rather than per row.
create or replace function public.current_workspace_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'workspace_id', '')::uuid;
$$;
