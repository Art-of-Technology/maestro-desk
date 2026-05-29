-- Pivot custom_fields + custom_field_values RLS to is_workspace_member,
-- carrying forward the OR-platform-admin broadening from 20260522140100
-- as is_platform_admin_jwt.

drop policy if exists custom_fields_ws       on custom_fields;
drop policy if exists custom_field_values_ws on custom_field_values;

create policy custom_fields_ws on custom_fields
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy custom_field_values_ws on custom_field_values
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());
