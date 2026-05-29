-- Pivot channels + inbox_messages RLS from current_workspace_id() to
-- is_workspace_member(), so inbox.ts can move to the user-scoped client.
--
-- Service-role callers elsewhere (inbound-email.ts inserts into
-- inbox_messages, postmark webhook reads channels) bypass RLS, so
-- their behaviour is unchanged.

drop policy if exists channels_ws       on channels;
drop policy if exists inbox_messages_ws on inbox_messages;

create policy channels_ws on channels
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy inbox_messages_ws on inbox_messages
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());
