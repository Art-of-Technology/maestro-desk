-- Inbound threading fix — two parts, both surfaced by a live round-trip test
-- where a customer reply (routed through the shared Postmark inbound address,
-- no per-brand domain) failed to attach to its ticket and 500'd the webhook.
--
-- 1) Index supporting the now workspace-agnostic In-Reply-To / dedup lookups
--    in lib/inbound-email.ts. The existing unique index is
--    (workspace_id, external_message_id) — its leading column is workspace_id,
--    so a lookup by external_message_id alone can't use it. Add a plain index
--    on external_message_id (the matching column) to keep those lookups fast.
--
-- 2) Seed the system "unrouted" bucket workspace (is_unrouted_bucket = true,
--    created bare in 20260522150000) with the standard statuses/priorities/
--    categories. Unmatched inbound mail falls back to this workspace and
--    creates a ticket with status_key='open' / priority_key='normal'; with no
--    lookup rows the FK (tickets_workspace_id_status_key_fkey) failed and the
--    webhook 500'd. Seeding lets unrouted mail land as a real ticket instead.

-- ── 1. Index for workspace-agnostic Message-ID matching ───────────────────
create index if not exists ts_msg_external_id
  on ticket_messages (external_message_id)
  where external_message_id is not null;

-- ── 2. Seed the unrouted bucket's lookup tables (idempotent) ───────────────
do $$
declare v_ws uuid;
begin
  select id into v_ws from workspaces where is_unrouted_bucket = true;
  if v_ws is null then return; end if;

  insert into ticket_statuses (workspace_id, key, label, color, sort_order, is_terminal) values
    (v_ws, 'open',      'Open',      'var(--cyan)',  10, false),
    (v_ws, 'escalated', 'Escalated', 'var(--red)',   20, false),
    (v_ws, 'pending',   'Pending',   'var(--amber)', 30, false),
    (v_ws, 'gdpr',      'GDPR',      'var(--red)',   40, false),
    (v_ws, 'resolved',  'Resolved',  'var(--green)', 90, true)
  on conflict (workspace_id, key) do nothing;

  insert into ticket_priorities (workspace_id, key, label, sort_order) values
    (v_ws, 'low',    'Low',    10),
    (v_ws, 'normal', 'Normal', 20),
    (v_ws, 'high',   'High',   30),
    (v_ws, 'urgent', 'Urgent', 40)
  on conflict (workspace_id, key) do nothing;

  -- Full iGaming category set (matches provision_brand) so background triage,
  -- which may assign any of these, never hits a missing-category FK.
  insert into ticket_categories (workspace_id, key, label) values
    (v_ws, 'Account',      'Account'),
    (v_ws, 'Payments',     'Payments'),
    (v_ws, 'DueDiligence', 'Due Diligence'),
    (v_ws, 'General',      'General'),
    (v_ws, 'Complaints',   'Complaints'),
    (v_ws, 'Product',      'Product'),
    (v_ws, 'Data',         'Data'),
    (v_ws, 'RG',           'Responsible Gaming'),
    (v_ws, 'Promotions',   'Promotions'),
    (v_ws, 'Fraud',        'Fraud'),
    (v_ws, 'Marketing',    'Marketing')
  on conflict (workspace_id, key) do nothing;
end $$;
