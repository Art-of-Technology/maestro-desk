-- Pivot customers + customer_notes RLS from current_workspace_id() to
-- is_workspace_member(). Same pattern as the ticket-family and
-- auth-tables pivots — moves these tables onto the JWT-claim-driven
-- helper so the user-scoped Supabase client can read/write them.
--
-- Service-role callers (every route except the newly-flipped
-- customers.ts) bypass RLS, so their behaviour is unchanged.

drop policy if exists customers_ws       on customers;
drop policy if exists customer_notes_ws  on customer_notes;

create policy customers_ws on customers
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy customer_notes_ws on customer_notes
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());
