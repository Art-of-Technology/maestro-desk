-- Enable RLS for the three integration tables for the first time, and
-- pin them to is_workspace_member. These were added after the original
-- RLS rollout (slack_integrations in PR #183, stripe in #184, shopify
-- in #185) and shipped without policies — every route accessing them
-- went through service-role, which bypasses RLS, so the gap wasn't
-- observable from the SPA. With integrations.ts flipping to the user-
-- scoped client in this PR, the policies become load-bearing: without
-- them, any authenticated user would be able to read every workspace's
-- Slack webhooks, Stripe keys, and Shopify tokens via direct
-- PostgREST traffic.

alter table slack_integrations   enable row level security;
alter table stripe_integrations  enable row level security;
alter table shopify_integrations enable row level security;

create policy slack_integrations_ws on slack_integrations
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy stripe_integrations_ws on stripe_integrations
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

create policy shopify_integrations_ws on shopify_integrations
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());

-- Also create a thread mapping table policy for two-way Slack — added
-- alongside the Slack integration table in 20260529100000, also without
-- RLS. Belongs to the same workspace-tenanted pattern.
alter table slack_thread_mappings enable row level security;

create policy slack_thread_mappings_ws on slack_thread_mappings
  for all to authenticated
  using      (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt())
  with check (public.is_workspace_member(workspace_id) or public.is_platform_admin_jwt());
