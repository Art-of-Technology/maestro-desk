-- Ensure the Supabase-managed roles exist (idempotent for local PG
-- validation; no-op on a real Supabase project where these are pre-created).
do $$ begin
  create role authenticated nologin;
exception when duplicate_object then null;
end $$;
do $$ begin
  create role anon nologin;
exception when duplicate_object then null;
end $$;

-- Ensure the auth schema + auth.uid() helper exist. On Supabase both are
-- already provided by gotrue and we MUST NOT overwrite them. The guard below
-- only stubs auth.uid() if no function with that name already exists.
create schema if not exists auth;
do $$ begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute 'create function auth.uid() returns uuid language sql stable as ''select null::uuid''';
  end if;
end $$;

-- Row-Level Security policies.
--
-- The pattern: every domain row carries workspace_id, and policies check it
-- against public.current_workspace_id() (defined in 20260520120000) which reads
-- the active workspace from the JWT. The API sets that JWT claim on sign-in
-- and on workspace-switch.
--
-- A few tables are special:
--   - permissions: global registry, readable to any authenticated user
--   - users: global identities; a user can see themselves and other members
--            of their active workspace
--   - role_permissions: not workspace_id-keyed directly; gated via the
--            role they reference
--   - tables joined off ticket_id but without their own workspace_id:
--            ticket_messages, ticket_attachments, ticket_links, ticket_tags,
--            ticket_ai_tags, time_entries — these all carry workspace_id
--            already (we put it there explicitly for cheap RLS evaluation).
--
-- The bypass role (service_role) used by the API skips RLS by design; user-
-- facing tokens (authenticated role) MUST satisfy these policies.

-- ─── Workspaces / users / membership ─────────────────────────────────────────

alter table workspaces enable row level security;

create policy workspaces_member_select on workspaces
  for select to authenticated
  using (
    id in (
      select workspace_id from workspace_members
      where user_id = auth.uid() and active = true
    )
  );

-- Workspaces are created via the signup endpoint (service_role); no INSERT
-- policy for authenticated. Updates are admin-only via the API too.

alter table users enable row level security;

create policy users_self_select on users
  for select to authenticated
  using (id = auth.uid());

create policy users_workspace_peer_select on users
  for select to authenticated
  using (
    id in (
      select user_id from workspace_members
      where workspace_id = public.current_workspace_id() and active = true
    )
  );

create policy users_self_update on users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

alter table workspace_members enable row level security;

create policy workspace_members_visible on workspace_members
  for select to authenticated
  using (workspace_id = public.current_workspace_id());

-- ─── Permissions / roles ────────────────────────────────────────────────────

alter table permissions enable row level security;

create policy permissions_all_read on permissions
  for select to authenticated
  using (true);

alter table roles enable row level security;

create policy roles_workspace_access on roles
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

alter table role_permissions enable row level security;

create policy role_permissions_via_role on role_permissions
  for all to authenticated
  using (
    role_id in (
      select id from roles where workspace_id = public.current_workspace_id()
    )
  )
  with check (
    role_id in (
      select id from roles where workspace_id = public.current_workspace_id()
    )
  );

-- ─── Lookups ────────────────────────────────────────────────────────────────

alter table ticket_statuses    enable row level security;
alter table ticket_priorities  enable row level security;
alter table ticket_categories  enable row level security;

create policy ticket_statuses_ws    on ticket_statuses
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy ticket_priorities_ws  on ticket_priorities
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy ticket_categories_ws  on ticket_categories
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- ─── Customers ──────────────────────────────────────────────────────────────

alter table customers       enable row level security;
alter table customer_notes  enable row level security;

create policy customers_ws on customers
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy customer_notes_ws on customer_notes
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- ─── Channels / inbox ───────────────────────────────────────────────────────

alter table channels         enable row level security;
alter table inbox_messages   enable row level security;

create policy channels_ws on channels
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy inbox_messages_ws on inbox_messages
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- ─── Tickets + related ──────────────────────────────────────────────────────

alter table tickets             enable row level security;
alter table ticket_messages     enable row level security;
alter table ticket_attachments  enable row level security;
alter table ticket_links        enable row level security;
alter table ticket_tags         enable row level security;
alter table ticket_ai_tags      enable row level security;
alter table tag_library         enable row level security;
alter table time_entries        enable row level security;

create policy tickets_ws            on tickets
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy ticket_messages_ws    on ticket_messages
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy ticket_attachments_ws on ticket_attachments
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy ticket_links_ws       on ticket_links
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy ticket_tags_ws        on ticket_tags
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy ticket_ai_tags_ws     on ticket_ai_tags
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy tag_library_ws        on tag_library
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy time_entries_ws       on time_entries
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- ─── Activity + audit ───────────────────────────────────────────────────────

alter table events        enable row level security;
alter table audit_events  enable row level security;

create policy events_ws on events
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- audit_events: read-only to authenticated; only the API (service_role) writes.
create policy audit_events_ws_read on audit_events
  for select to authenticated
  using (workspace_id = public.current_workspace_id());

-- ─── Automation ─────────────────────────────────────────────────────────────

alter table workflows      enable row level security;
alter table workflow_runs  enable row level security;
alter table sla_policies   enable row level security;
alter table assign_rules   enable row level security;

create policy workflows_ws      on workflows
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy workflow_runs_ws  on workflow_runs
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy sla_policies_ws   on sla_policies
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy assign_rules_ws   on assign_rules
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- ─── Custom fields ──────────────────────────────────────────────────────────

alter table custom_fields        enable row level security;
alter table custom_field_values  enable row level security;

create policy custom_fields_ws         on custom_fields
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy custom_field_values_ws   on custom_field_values
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- ─── Content libraries ──────────────────────────────────────────────────────

alter table canned_responses   enable row level security;
alter table ticket_templates   enable row level security;
alter table kb_articles        enable row level security;
alter table kb_votes           enable row level security;

create policy canned_responses_ws on canned_responses
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy ticket_templates_ws on ticket_templates
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy kb_articles_ws on kb_articles
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy kb_votes_ws on kb_votes
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

-- ─── Per-user state ─────────────────────────────────────────────────────────

alter table message_drafts        enable row level security;
alter table user_preferences      enable row level security;
alter table notification_state    enable row level security;

create policy message_drafts_self on message_drafts
  for all to authenticated
  using (user_id = auth.uid() and workspace_id = public.current_workspace_id())
  with check (user_id = auth.uid() and workspace_id = public.current_workspace_id());

create policy user_preferences_self on user_preferences
  for all to authenticated
  using (user_id = auth.uid() and workspace_id = public.current_workspace_id())
  with check (user_id = auth.uid() and workspace_id = public.current_workspace_id());

create policy notification_state_self on notification_state
  for all to authenticated
  using (user_id = auth.uid() and workspace_id = public.current_workspace_id())
  with check (user_id = auth.uid() and workspace_id = public.current_workspace_id());

-- ─── Workspace config ───────────────────────────────────────────────────────

alter table business_hours       enable row level security;
alter table webhooks             enable row level security;
alter table webhook_deliveries   enable row level security;

create policy business_hours_ws       on business_hours
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy webhooks_ws             on webhooks
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());

create policy webhook_deliveries_ws   on webhook_deliveries
  for select to authenticated
  using (workspace_id = public.current_workspace_id());

-- ─── AI ─────────────────────────────────────────────────────────────────────

alter table ai_conversations   enable row level security;
alter table ai_messages        enable row level security;

create policy ai_conversations_self on ai_conversations
  for all to authenticated
  using (user_id = auth.uid() and workspace_id = public.current_workspace_id())
  with check (user_id = auth.uid() and workspace_id = public.current_workspace_id());

create policy ai_messages_via_conversation on ai_messages
  for all to authenticated
  using (
    workspace_id = public.current_workspace_id()
    and conversation_id in (select id from ai_conversations where user_id = auth.uid())
  )
  with check (
    workspace_id = public.current_workspace_id()
    and conversation_id in (select id from ai_conversations where user_id = auth.uid())
  );

-- ─── GDPR ───────────────────────────────────────────────────────────────────

alter table gdpr_erasures enable row level security;

create policy gdpr_erasures_ws_read on gdpr_erasures
  for select to authenticated
  using (workspace_id = public.current_workspace_id());

-- Writes to gdpr_erasures go through the API (service_role) so an audit row
-- is always emitted alongside the actual PII null-out.
