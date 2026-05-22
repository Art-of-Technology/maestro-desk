-- RLS escape-hatch sweep for the platform-admin role.
--
-- Every workspace-scoped policy gets `OR public.is_platform_admin()` added to
-- its USING (and WITH CHECK where applicable). The platform admin can then
-- read and write across all workspaces without needing to switch the JWT
-- workspace_id claim or use service_role.
--
-- We use ALTER POLICY (not DROP + CREATE) so the change is a single in-place
-- expression swap — no window where the policy is missing. Idempotent on re-
-- run: applying the same USING expression again is a no-op.
--
-- Sections mirror 20260520121400_rls_policies.sql so a side-by-side grep
-- shows every policy is accounted for. Three categories of policy here:
--   1. Workspace-scoped only — add `OR is_platform_admin()` straightforwardly.
--   2. User-scoped (drafts, prefs, notifications, ai conversations) — also
--      gain the escape hatch. Platform admin needs to inspect these for
--      support cases ("my saved draft disappeared"). Reads of PII-leaning
--      tables MUST be audited by the API layer (audit_events).
--   3. Indirect (role_permissions via roles, ai_messages via conversation)
--      — escape hatch added at the top level of the OR chain.
--
-- The two policies on `users` are special:
--   - users_self_select / users_workspace_peer_select / users_self_update —
--     left mostly alone except peer_select + self_update get the escape
--     hatch so platform admin can list and update any user record (needed
--     to grant/revoke is_platform_admin and to invite brand owners).
--
-- Notes:
--   - This migration touches only USING / WITH CHECK clauses. No table or
--     policy is dropped. Policy names remain stable so future grep continues
--     to work.
--   - The service_role bypasses RLS entirely (BYPASSRLS attribute), so this
--     change has zero effect on the API server. It only matters for direct
--     authenticated-role traffic (browser → PostgREST), which currently
--     isn't wired (see PR #133 RLS gotcha note); but defense-in-depth and
--     future-proof.

-- ─── Workspaces / users / membership ─────────────────────────────────────────

alter policy workspaces_member_select on workspaces
  using (
    id in (
      select workspace_id from workspace_members
      where user_id = auth.uid() and active = true
    )
    or public.is_platform_admin()
  );

alter policy users_workspace_peer_select on users
  using (
    id in (
      select user_id from workspace_members
      where workspace_id = public.current_workspace_id() and active = true
    )
    or public.is_platform_admin()
  );

alter policy users_self_update on users
  using (id = auth.uid() or public.is_platform_admin())
  with check (id = auth.uid() or public.is_platform_admin());

alter policy workspace_members_visible on workspace_members
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── Permissions / roles ────────────────────────────────────────────────────

-- permissions_all_read on permissions: already `using (true)`. No change.

alter policy roles_workspace_access on roles
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy role_permissions_via_role on role_permissions
  using (
    role_id in (
      select id from roles where workspace_id = public.current_workspace_id()
    )
    or public.is_platform_admin()
  )
  with check (
    role_id in (
      select id from roles where workspace_id = public.current_workspace_id()
    )
    or public.is_platform_admin()
  );

-- ─── Lookups ────────────────────────────────────────────────────────────────

alter policy ticket_statuses_ws on ticket_statuses
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy ticket_priorities_ws on ticket_priorities
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy ticket_categories_ws on ticket_categories
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── Customers ──────────────────────────────────────────────────────────────

alter policy customers_ws on customers
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy customer_notes_ws on customer_notes
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── Channels / inbox ───────────────────────────────────────────────────────

alter policy channels_ws on channels
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy inbox_messages_ws on inbox_messages
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── Tickets + related ──────────────────────────────────────────────────────

alter policy tickets_ws on tickets
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy ticket_messages_ws on ticket_messages
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy ticket_attachments_ws on ticket_attachments
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy ticket_links_ws on ticket_links
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy ticket_tags_ws on ticket_tags
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy ticket_ai_tags_ws on ticket_ai_tags
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy tag_library_ws on tag_library
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy time_entries_ws on time_entries
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── Activity + audit ───────────────────────────────────────────────────────

alter policy events_ws on events
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy audit_events_ws_read on audit_events
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── Automation ─────────────────────────────────────────────────────────────

alter policy workflows_ws on workflows
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy workflow_runs_ws on workflow_runs
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy sla_policies_ws on sla_policies
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy assign_rules_ws on assign_rules
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── Custom fields ──────────────────────────────────────────────────────────

alter policy custom_fields_ws on custom_fields
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy custom_field_values_ws on custom_field_values
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── Content libraries ──────────────────────────────────────────────────────

alter policy canned_responses_ws on canned_responses
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy ticket_templates_ws on ticket_templates
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy kb_articles_ws on kb_articles
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy kb_votes_ws on kb_votes
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── Per-user state ─────────────────────────────────────────────────────────

alter policy message_drafts_self on message_drafts
  using (
    (user_id = auth.uid() and workspace_id = public.current_workspace_id())
    or public.is_platform_admin()
  )
  with check (
    (user_id = auth.uid() and workspace_id = public.current_workspace_id())
    or public.is_platform_admin()
  );

alter policy user_preferences_self on user_preferences
  using (
    (user_id = auth.uid() and workspace_id = public.current_workspace_id())
    or public.is_platform_admin()
  )
  with check (
    (user_id = auth.uid() and workspace_id = public.current_workspace_id())
    or public.is_platform_admin()
  );

alter policy notification_state_self on notification_state
  using (
    (user_id = auth.uid() and workspace_id = public.current_workspace_id())
    or public.is_platform_admin()
  )
  with check (
    (user_id = auth.uid() and workspace_id = public.current_workspace_id())
    or public.is_platform_admin()
  );

-- ─── Workspace config ───────────────────────────────────────────────────────

alter policy business_hours_ws on business_hours
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy webhooks_ws on webhooks
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin())
  with check (workspace_id = public.current_workspace_id() or public.is_platform_admin());

alter policy webhook_deliveries_ws on webhook_deliveries
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── AI ─────────────────────────────────────────────────────────────────────

alter policy ai_conversations_self on ai_conversations
  using (
    (user_id = auth.uid() and workspace_id = public.current_workspace_id())
    or public.is_platform_admin()
  )
  with check (
    (user_id = auth.uid() and workspace_id = public.current_workspace_id())
    or public.is_platform_admin()
  );

alter policy ai_messages_via_conversation on ai_messages
  using (
    (
      workspace_id = public.current_workspace_id()
      and conversation_id in (select id from ai_conversations where user_id = auth.uid())
    )
    or public.is_platform_admin()
  )
  with check (
    (
      workspace_id = public.current_workspace_id()
      and conversation_id in (select id from ai_conversations where user_id = auth.uid())
    )
    or public.is_platform_admin()
  );

alter policy ai_usage_log_ws_read on ai_usage_log
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin());

-- ─── GDPR ───────────────────────────────────────────────────────────────────

alter policy gdpr_erasures_ws_read on gdpr_erasures
  using (workspace_id = public.current_workspace_id() or public.is_platform_admin());
