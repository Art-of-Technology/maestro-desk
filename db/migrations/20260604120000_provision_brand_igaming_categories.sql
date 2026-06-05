-- Update provision_brand's default ticket categories to the iGaming-oriented
-- set used for real brands. maestro-desk is an iGaming-focused help desk, so a
-- new brand should start with operationally relevant categories rather than
-- the generic Billing/Technical/Account/GDPR/Feature placeholder set.
--
-- Default categories (key -> label):
--   Account, Payments, DueDiligence ("Due Diligence"), General, Complaints,
--   Product, Data, RG ("Responsible Gaming"), Promotions, Fraud, Marketing.
--
-- NOTE: this intentionally DIVERGES from the demo workspace seed
-- (20260520121500_seed_demo.sql), which keeps its original illustrative
-- categories because demo tickets + channels.default_category_key reference
-- them. Only the function body's category block changes here; everything else
-- is reproduced verbatim from 20260522160000_provision_brand_fn.sql.
--
-- GDPR/data-protection: the old default set had a 'GDPR' *category*; the new
-- set does not, by design. Categories and statuses are independent dimensions:
-- the 'gdpr' ticket_status is deliberately RETAINED (see section 4) as the
-- workflow state for data-protection cases, and data/privacy requests map to
-- the 'Data' category. The SPA's GDPR action panel keys off the status OR the
-- category, so retaining the status keeps it working for new brands. A freshly
-- provisioned brand has no channels/workflows/SLAs/tickets yet, so dropping the
-- category breaks no existing references.

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
  v_workspace_id     uuid;
  v_admin_role_id    uuid;
  v_senior_role_id   uuid;
  v_readonly_role_id uuid;
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

  -- 2. Roles. Names + is_admin flag mirror the demo seed. IDs captured by
  -- name-lookup after the multi-row INSERT (RETURNING INTO a scalar can't
  -- handle multiple rows).
  insert into roles (workspace_id, name, is_admin) values
    (v_workspace_id, 'Admin',        true),
    (v_workspace_id, 'Senior Agent', false),
    (v_workspace_id, 'Read Only',    false);
  select id into v_admin_role_id    from roles where workspace_id = v_workspace_id and name = 'Admin';
  select id into v_senior_role_id   from roles where workspace_id = v_workspace_id and name = 'Senior Agent';
  select id into v_readonly_role_id from roles where workspace_id = v_workspace_id and name = 'Read Only';

  -- 3. Role permissions. Admin = everything; Senior Agent = ROLES_MATRIX
  -- subset from data.js; Read Only = reports only.
  insert into role_permissions (role_id, permission_key)
    select v_admin_role_id, key from permissions;

  insert into role_permissions (role_id, permission_key) values
    (v_senior_role_id, 'tickets'),
    (v_senior_role_id, 'customers'),
    (v_senior_role_id, 'reports'),
    (v_senior_role_id, 'ai'),
    (v_senior_role_id, 'tags'),
    (v_senior_role_id, 'gdpr');

  insert into role_permissions (role_id, permission_key) values
    (v_readonly_role_id, 'reports');

  -- 4. Lookup tables — statuses/priorities match the demo seed; categories use
  -- the iGaming default set (see header).
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

  -- 5. Business hours — Mon–Fri 9–18, Sat/Sun disabled. Same shape as the
  -- demo seed; the SPA's business-hours editor mutates this jsonb in place.
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

  -- 6. Email domain mapping (optional). Inbound webhook in PR D uses this
  -- table to route mail to the right workspace.
  if p_domain is not null and length(trim(p_domain)) > 0 then
    insert into workspace_email_domains (workspace_id, domain)
      values (v_workspace_id, p_domain);
  end if;

  return v_workspace_id;
end;
$$;
