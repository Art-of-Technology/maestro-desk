-- Tickets RLS pivot: switch the ticket-family policies from the legacy
-- `current_workspace_id()` helper (which reads a single workspace_id
-- claim that the Custom Access Token Hook deliberately does NOT inject)
-- to the new `is_workspace_member()` helper (which reads the
-- workspace_ids array the hook DOES inject).
--
-- The API still uses service-role on every ticket route in this PR, so
-- nothing observable changes for end users. The point of this slice is
-- to:
--   (a) have the helper functions defined,
--   (b) have the ticket-family policies expressed in terms of them,
-- so the follow-up PR that flips tickets.ts to the user-scoped client
-- (sbUser) can land without simultaneously editing RLS — that
-- separation makes a rollback per slice safe.
--
-- PREREQUISITE: the Custom Access Token Hook (added in 20260529110000)
-- must be enabled in Supabase Dashboard → Authentication → Hooks. Until
-- it is, the new policies deny everything to the authenticated role
-- (workspace_ids claim is missing → is_workspace_member returns false).
-- The API service-role bypasses RLS, so this denial is invisible to
-- production traffic until the route layer pivots.

-- ─── Helpers ────────────────────────────────────────────────────────────

-- True when the workspace_id appears in the caller's JWT workspace_ids
-- claim. NULL claim (hook disabled, or non-authenticated caller) ⇒
-- false. SECURITY DEFINER not needed: this only reads the JWT context,
-- which is per-request and trusted.
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
as $$
  select coalesce(
    ws::text in (
      select jsonb_array_elements_text(
        coalesce(
          (current_setting('request.jwt.claims', true)::jsonb -> 'workspace_ids'),
          '[]'::jsonb
        )
      )
    ),
    false
  );
$$;

-- True when the JWT carries is_platform_admin=true. Mirrors the existing
-- public.is_platform_admin() pattern but reads from the hook-injected
-- claim instead of a per-query users lookup.
create or replace function public.is_platform_admin_jwt()
returns boolean
language sql
stable
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'is_platform_admin')::boolean,
    false
  );
$$;

-- ─── Pivot ticket-family policies ────────────────────────────────────────
--
-- Pattern: drop the old `*_ws` policy, create a new one with the same
-- name backed by is_workspace_member. Platform admins are granted
-- access via the OR clause for consistency with existing god-mode
-- behaviour elsewhere in the schema.

drop policy if exists tickets_ws            on tickets;
drop policy if exists ticket_messages_ws    on ticket_messages;
drop policy if exists ticket_attachments_ws on ticket_attachments;
drop policy if exists ticket_links_ws       on ticket_links;
drop policy if exists ticket_tags_ws        on ticket_tags;
drop policy if exists ticket_ai_tags_ws     on ticket_ai_tags;
drop policy if exists tag_library_ws        on tag_library;
drop policy if exists time_entries_ws       on time_entries;

create policy tickets_ws on tickets
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy ticket_messages_ws on ticket_messages
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy ticket_attachments_ws on ticket_attachments
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy ticket_links_ws on ticket_links
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy ticket_tags_ws on ticket_tags
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy ticket_ai_tags_ws on ticket_ai_tags
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy tag_library_ws on tag_library
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy time_entries_ws on time_entries
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());
