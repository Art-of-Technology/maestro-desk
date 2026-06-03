-- Pin search_path on the functions that lacked it, resolving the Security
-- Advisor `function_search_path_mutable` (WARN) findings.
--
-- A mutable search_path lets a caller shadow unqualified names a function
-- resolves at run time. Each function below references only built-ins
-- (now(), current_setting, jsonb/coalesce/nullif) or fully-qualified objects
-- (public.tickets), so `set search_path = ''` is behaviour-preserving —
-- verified on Docker PG 17 (functions still execute; the updated_at trigger
-- still stamps now()).
--
-- The SECURITY DEFINER functions elsewhere (ai_budget, platform_admin,
-- provision_brand, custom_access_token_hook, workspace admin helpers) already
-- pin search_path, so they are not flagged and not touched here.

alter function public.trigger_set_updated_at()  set search_path = '';
alter function public.current_workspace_id()     set search_path = '';
alter function public.is_workspace_member(uuid)  set search_path = '';
alter function public.is_platform_admin_jwt()    set search_path = '';
alter function public.bump_ticket_updated_at()   set search_path = '';
