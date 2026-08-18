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
-- The one exception (any member may delete a BLANK ticket — no messages
-- beyond 'system' rows) is enforced in the ticket delete route, not here.

-- ─── 1. Column + backfill ───────────────────────────────────────────────────
alter table roles
  add column if not exists can_delete boolean not null default false;

-- Existing workspaces: admins can always delete. No non-admin role gets the
-- flag by default — the product spec is "off for all roles except Admin".
update roles
  set can_delete = true
  where is_admin = true;

-- ─── 2. Seed the flag for newly provisioned brands ──────────────────────────
-- Reproduced from 20260619130000_role_can_manage_custom_fields.sql; the only
-- change is the roles INSERT, which now also sets can_delete (Admin => true,
-- everyone else => false). Everything else is identical.
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

  -- 2. Roles. Names + is_admin flag mirror the demo seed. Access is governed
  -- by is_admin; can_manage_custom_fields additionally lets Senior Agents
  -- (and admins) create/remove custom-field definitions; can_delete gates
  -- deleting tickets/customers/notes and merging customer profiles (Admin
  -- only by default — grant per role from the Roles page).
  insert into roles (workspace_id, name, is_admin, can_manage_custom_fields, can_delete) values
    (v_workspace_id, 'Admin',        true,  true,  true),
    (v_workspace_id, 'Senior Agent', false, true,  false),
    (v_workspace_id, 'Read Only',    false, false, false);

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
