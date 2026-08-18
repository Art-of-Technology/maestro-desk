-- Add the second enforced per-role capability: can_delete.
--
-- Background: deleting tickets/customers/notes (and merging customer
-- profiles) becomes a real, server-persisted operation in Phase 2 of the
-- Aug-2026 update programme. Those operations are gated by this flag rather
-- than the binary is_admin: delete buttons disappear for everyone by
-- default, and only roles an admin explicitly grants can_delete (plus
-- admins themselves) may delete or merge. Role names are workspace-editable,
-- so we can't key off a literal name; this is a real, enforced flag —
-- same pattern as can_manage_custom_fields (20260619130000).
--
-- Enforcement lands with the delete/merge routes in the follow-up PRs of
-- this stack; until those merge the flag is stored and surfaced but not
-- yet consulted. The one exception (any member may delete a BLANK ticket —
-- no messages beyond 'system' rows) is enforced in the ticket delete
-- route, not here.
--
-- NO backfill: the admin grant is IMPLICIT. Every read path
-- (authz.ts, whoami.ts, the SPA role map) computes is_admin OR can_delete,
-- so materialising can_delete=true onto admin roles would only create a
-- retention leak — a role demoted from is_admin would silently keep a
-- materialised can_delete=true. Raw can_delete therefore means exactly
-- "explicitly granted", for admin and non-admin roles alike.

-- ─── 1. Column ──────────────────────────────────────────────────────────────
alter table roles
  add column if not exists can_delete boolean not null default false;

-- ─── 2. Extract role seeding out of provision_brand ─────────────────────────
-- provision_brand has now been recreated wholesale five times just to touch
-- its 3-row roles INSERT (20260522160000, 20260604120000, 20260619120000,
-- 20260619130000, and this migration). Pull the role seeding into its own
-- function so the NEXT capability migration redefines only this small seeder
-- and can't silently revert unrelated provision_brand changes.
--
-- can_manage_custom_fields keeps its historical materialised Admin=true (it
-- predates the implicit-grant rule and existing rows already carry it);
-- can_delete follows the new rule and stays false everywhere by default.
create or replace function public.seed_default_roles(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into roles (workspace_id, name, is_admin, can_manage_custom_fields, can_delete) values
    (p_workspace_id, 'Admin',        true,  true,  false),
    (p_workspace_id, 'Senior Agent', false, true,  false),
    (p_workspace_id, 'Read Only',    false, false, false);
end;
$$;

-- ─── 3. provision_brand delegates role seeding ───────────────────────────────
-- Reproduced from 20260619130000_role_can_manage_custom_fields.sql; the only
-- change is that the inline roles INSERT is replaced by a call to
-- seed_default_roles(). Everything else is identical.
create or replace function public.provision_brand(
  p_name                          text,
  p_slug                          text,
  p_domain                        text     default null,
  p_logo_url                      text     default null,
  p_primary_color                 text     default null,
  p_support_email_display_name    text     default null,
  p_ai_credits_micro              bigint   default 0,
  p_auto_reply_min_confidence     smallint default null,
  p_auto_reply_categories         text[]   default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workspace_id uuid;
begin
  -- 1. Workspace row.
  insert into workspaces (
    slug, name, plan, ai_credits_micro,
    logo_url, primary_color, support_email_display_name,
    auto_reply_min_confidence, auto_reply_categories
  )
  values (
    p_slug, p_name, 'trial', p_ai_credits_micro,
    p_logo_url, p_primary_color, p_support_email_display_name,
    p_auto_reply_min_confidence, p_auto_reply_categories
  )
  returning id into v_workspace_id;

  -- 2. Roles — seeded by seed_default_roles() (see above) so capability
  -- migrations no longer have to recreate this whole function.
  perform seed_default_roles(v_workspace_id);

  -- 3. Lookup tables — statuses/priorities match the demo seed; categories use
  -- the iGaming default set.
  insert into ticket_statuses (workspace_id, key, label, color, sort_order, is_terminal) values
    (v_workspace_id, 'open',      'Open',      'var(--cyan)',  10, false),
    (v_workspace_id, 'escalated', 'Escalated', 'var(--red)',   20, false),
    (v_workspace_id, 'pending',   'Pending',   'var(--amber)', 30, false),
    (v_workspace_id, 'gdpr',      'GDPR',      'var(--red)',   40, false),
    (v_workspace_id, 'resolved',  'Resolved',  'var(--green)', 90, true);

  insert into ticket_priorities (workspace_id, key, label, sort_order) values
    (v_workspace_id, 'low',    'Low',    10),
    (v_workspace_id, 'normal', 'Normal', 20),
    (v_workspace_id, 'high',   'High',   30),
    (v_workspace_id, 'urgent', 'Urgent', 40);

  insert into ticket_categories (workspace_id, key, label) values
    (v_workspace_id, 'Account',       'Account'),
    (v_workspace_id, 'Payments',      'Payments'),
    (v_workspace_id, 'DueDiligence',  'Due Diligence'),
    (v_workspace_id, 'General',       'General'),
    (v_workspace_id, 'Complaints',    'Complaints'),
    (v_workspace_id, 'Product',       'Product'),
    (v_workspace_id, 'Data',          'Data'),
    (v_workspace_id, 'RG',            'Responsible Gaming'),
    (v_workspace_id, 'Promotions',    'Promotions'),
    (v_workspace_id, 'Fraud',         'Fraud'),
    (v_workspace_id, 'Marketing',     'Marketing');

  -- 4. Business hours — Mon–Fri 9–18, Sat/Sun disabled.
  insert into business_hours (workspace_id, enabled, days, holidays) values (
    v_workspace_id, true,
    '[
      {"label":"Mon","enabled":true, "start":"09:00","end":"18:00"},
      {"label":"Tue","enabled":true, "start":"09:00","end":"18:00"},
      {"label":"Wed","enabled":true, "start":"09:00","end":"18:00"},
      {"label":"Thu","enabled":true, "start":"09:00","end":"18:00"},
      {"label":"Fri","enabled":true, "start":"09:00","end":"18:00"},
      {"label":"Sat","enabled":false,"start":"09:00","end":"18:00"},
      {"label":"Sun","enabled":false,"start":"09:00","end":"18:00"}
    ]'::jsonb,
    '{}'
  );

  -- 5. Email domain mapping (optional).
  if p_domain is not null and length(trim(p_domain)) > 0 then
    insert into workspace_email_domains (workspace_id, domain)
      values (v_workspace_id, p_domain);
  end if;

  return v_workspace_id;
end;
$$;
