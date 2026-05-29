-- Pivot kb_articles + kb_votes RLS from current_workspace_id() to
-- is_workspace_member(), so kb.ts can move to the user-scoped client.
--
-- The 20260522140100_platform_admin_rls migration had previously
-- broadened these policies to `OR is_platform_admin()` (the
-- function-based variant). We carry that forward as
-- `OR is_platform_admin_jwt()` — semantically equivalent under the
-- JWT-claim regime.

drop policy if exists kb_articles_ws on kb_articles;
drop policy if exists kb_votes_ws    on kb_votes;

create policy kb_articles_ws on kb_articles
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy kb_votes_ws on kb_votes
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());
