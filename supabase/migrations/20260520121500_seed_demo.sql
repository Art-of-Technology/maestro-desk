-- ─── DEMO SEED ──────────────────────────────────────────────────────────────
-- Ports the contents of js/core/data.js into the database so the existing UI
-- can run against Postgres with no visible change.
--
-- All UUIDs are deterministic ('00000000-0000-0000-0000-NNNNNNNNNNNN') so:
--   - foreign keys can be hard-coded inline below
--   - re-applying the seed is idempotent if combined with TRUNCATE
--   - you can grep for them in the codebase if needed during dev
--
-- ⚠ DROP THIS MIGRATION (or DELETE its rows) BEFORE GOING TO PRODUCTION.
-- Customers / tickets / msgs in here are entirely fictional, but they're
-- still test fixtures and shouldn't live in a real tenant's workspace.
-- ────────────────────────────────────────────────────────────────────────────

-- The migration runs as the postgres role which bypasses RLS, so we don't
-- need to disable policies explicitly. If you re-run this file outside a
-- migration context, do it through the SQL editor (also bypasses RLS).

-- ─── Workspace + users + roles + membership ─────────────────────────────────

insert into workspaces (id, slug, name, plan) values
  ('00000000-0000-0000-0000-000000000001', 'demo', 'Demo workspace', 'trial');

insert into users (id, email, name, initials) values
  ('00000000-0000-0000-0000-000000000101', 'emma.clarke@maestrodesk.demo',  'Emma Clarke',  'EC'),
  ('00000000-0000-0000-0000-000000000102', 'james.webb@maestrodesk.demo',   'James Webb',   'JW'),
  ('00000000-0000-0000-0000-000000000103', 'sofia.reyes@maestrodesk.demo',  'Sofia Reyes',  'SR'),
  ('00000000-0000-0000-0000-000000000104', 'priya.nair@maestrodesk.demo',   'Priya Nair',   'PN'),
  ('00000000-0000-0000-0000-000000000105', 'tom.bates@maestrodesk.demo',    'Tom Bates',    'TB');

insert into roles (id, workspace_id, name, is_admin) values
  ('00000000-0000-0000-0000-000000000a01', '00000000-0000-0000-0000-000000000001', 'Admin',        true),
  ('00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-000000000001', 'Senior Agent', false),
  ('00000000-0000-0000-0000-000000000a03', '00000000-0000-0000-0000-000000000001', 'Read Only',    false);

-- Admin: all permissions
insert into role_permissions (role_id, permission_key)
  select '00000000-0000-0000-0000-000000000a01', key from permissions;

-- Senior Agent: per ROLES_MATRIX in data.js — tickets, customers, reports, ai, tags, gdpr
insert into role_permissions (role_id, permission_key) values
  ('00000000-0000-0000-0000-000000000a02', 'tickets'),
  ('00000000-0000-0000-0000-000000000a02', 'customers'),
  ('00000000-0000-0000-0000-000000000a02', 'reports'),
  ('00000000-0000-0000-0000-000000000a02', 'ai'),
  ('00000000-0000-0000-0000-000000000a02', 'tags'),
  ('00000000-0000-0000-0000-000000000a02', 'gdpr');

-- Read Only: just reports
insert into role_permissions (role_id, permission_key) values
  ('00000000-0000-0000-0000-000000000a03', 'reports');

-- Membership — Emma = Admin, the rest = Senior Agent (matches data.js AGENTS roles).
-- Sofia's role in data.js is 'Read Only' — keep that fidelity here.
insert into workspace_members (workspace_id, user_id, role_id, active, ooo_from, ooo_to, ooo_note) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000a01', true, null, null, null),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000a02', true, null, null, null),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000a03', true, null, null, null),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000a02', true, '2026-05-04', '2026-05-08', 'Annual leave — back Friday'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-000000000a02', true, null, null, null);

-- ─── Lookups ────────────────────────────────────────────────────────────────

insert into ticket_statuses (workspace_id, key, label, color, sort_order, is_terminal) values
  ('00000000-0000-0000-0000-000000000001', 'open',       'Open',       'var(--cyan)',   10, false),
  ('00000000-0000-0000-0000-000000000001', 'escalated',  'Escalated',  'var(--red)',    20, false),
  ('00000000-0000-0000-0000-000000000001', 'pending',    'Pending',    'var(--amber)',  30, false),
  ('00000000-0000-0000-0000-000000000001', 'gdpr',       'GDPR',       'var(--red)',    40, false),
  ('00000000-0000-0000-0000-000000000001', 'resolved',   'Resolved',   'var(--green)',  90, true);

insert into ticket_priorities (workspace_id, key, label, sort_order) values
  ('00000000-0000-0000-0000-000000000001', 'low',     'Low',     10),
  ('00000000-0000-0000-0000-000000000001', 'normal',  'Normal',  20),
  ('00000000-0000-0000-0000-000000000001', 'high',    'High',    30),
  ('00000000-0000-0000-0000-000000000001', 'urgent',  'Urgent',  40);

insert into ticket_categories (workspace_id, key, label) values
  ('00000000-0000-0000-0000-000000000001', 'Billing',   'Billing'),
  ('00000000-0000-0000-0000-000000000001', 'Technical', 'Technical'),
  ('00000000-0000-0000-0000-000000000001', 'Account',   'Account'),
  ('00000000-0000-0000-0000-000000000001', 'GDPR',      'GDPR'),
  ('00000000-0000-0000-0000-000000000001', 'Feature',   'Feature');

-- ─── Channels ───────────────────────────────────────────────────────────────

insert into channels (id, workspace_id, display_id, name, type, address, status, default_category_key, default_assigned_user_id, signature, volume_30d) values
  ('00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000001', 'CH-001', 'Support inbox',           'email',   'support@maestrodesk.com',     'active',   null,        null, '— Maestro Desk Support', 142),
  ('00000000-0000-0000-0000-000000000c02', '00000000-0000-0000-0000-000000000001', 'CH-002', 'Billing inbox',           'email',   'billing@maestrodesk.com',     'active',   'Billing',   '00000000-0000-0000-0000-000000000103', '— Maestro Desk Billing', 38),
  ('00000000-0000-0000-0000-000000000c03', '00000000-0000-0000-0000-000000000001', 'CH-003', 'Public help portal',      'webform', 'maestrodesk.com/help/contact','active',   null,        null, '', 64),
  ('00000000-0000-0000-0000-000000000c04', '00000000-0000-0000-0000-000000000001', 'CH-004', 'In-app chat widget',      'chat',    'widget://embed',              'active',   'Technical', '00000000-0000-0000-0000-000000000102', 'Hi! Maestro Desk live chat — how can we help?', 212),
  ('00000000-0000-0000-0000-000000000c05', '00000000-0000-0000-0000-000000000001', 'CH-005', 'Partner API integration', 'api',     '/api/v1/tickets',             'inactive', null,        null, '', 0);

-- ─── Inbox messages (pre-conversion) ────────────────────────────────────────

insert into inbox_messages (id, workspace_id, channel_id, from_name, from_email, subject, body, received_at, status) values
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000c01', 'Sarah Mitchell',  'sarah.m@acme.com',          'Card keeps getting declined at checkout',                'Hi, I''ve tried three different cards and the checkout flow keeps failing on the final step. The page just spins for a while and then says "Something went wrong". I''m on Chrome on a Mac. Order total was £148. Could you help?\n\nThanks,\nSarah', '2025-04-17 09:14+00', 'new'),
  ('00000000-0000-0000-0000-000000000e02', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000c02', 'James Reed',      'james.r@globex.io',         'March invoice missing',                                  'Hi billing,\n\nI can''t find the March 2025 invoice in my account. I need it for our finance team''s month-end close. Can you resend it as a PDF?\n\nReference: GLO-2025-03\n\nJames Reed\nGlobex Finance', '2025-04-17 10:22+00', 'new'),
  ('00000000-0000-0000-0000-000000000e03', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000c01', 'Carlos Diaz',     'carlos@tyrell.com',         'iOS app crashing on login',                              'Since the last update the iOS app crashes the moment I tap "Sign in". Force-closing and reopening doesn''t help. iPhone 14 Pro, iOS 17.4.\n\n— Carlos', '2025-04-17 11:03+00', 'new'),
  ('00000000-0000-0000-0000-000000000e04', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000c01', 'Unknown sender',  'newsletter@offers.example', '🔥 Limited time — upgrade your account today!',         'Click here for an exclusive offer just for you! Reply STOP to unsubscribe.', '2025-04-17 11:30+00', 'new'),
  ('00000000-0000-0000-0000-000000000e05', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000c02', 'Priya Sharma',    'priya@nakatomi.jp',         'Subscription renewal date question',                     'Hello,\n\nWhen exactly does my subscription auto-renew? I want to make sure my card on file is up to date before it processes.\n\nThanks,\nPriya', '2025-04-17 12:48+00', 'new'),
  ('00000000-0000-0000-0000-000000000e06', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000c01', 'Tom Brewer',      'tom@umbrella.co',           'Forgot to mention - export to XLSX too?',                'Following up on my earlier export request — could the CSV export also be available as XLSX? Excel parses dates funny on the CSV.\n\n— Tom', '2025-04-17 13:11+00', 'new'),
  ('00000000-0000-0000-0000-000000000e07', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000c01', 'Nina Kowalski',   'nina@initech.com',          'Re: Initial setup help — thanks!',                       'Just wanted to say the setup walkthrough was excellent. Got everything configured in under 30 mins. Cheers.\n\nNina', '2025-04-17 14:02+00', 'new');

-- ─── Customers ──────────────────────────────────────────────────────────────

insert into customers (id, workspace_id, display_id, first_name, last_name, username, email, mobile, brand, vip_tier, jurisdiction, consent, kyc_status, since, backoffice_url) values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000001', 'M001', 'Sarah',  'Mitchell',  'smitchell', 'sarah.m@acme.com',  '+44 7700 100001',  'Acme Corp',  'Gold',     'UK', true,  'Verified', '2023-01-15', 'https://backoffice.example.com/M001'),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000001', 'M002', 'James',  'Reed',      'jreed',     'james.r@globex.io', '+44 7700 100002',  'Globex',     'Silver',   'IE', true,  'Pending',  '2022-11-03', 'https://backoffice.example.com/M002'),
  ('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000001', 'M003', 'Nina',   'Kowalski',  'nina_k',    'nina@initech.com',  '+49 151 20000003', 'Initech',    'Platinum', 'DE', false, 'Verified', '2021-06-20', 'https://backoffice.example.com/M003'),
  ('00000000-0000-0000-0000-000000000204', '00000000-0000-0000-0000-000000000001', 'M004', 'Tom',    'Brewer',    'tbrewer',   'tom@umbrella.co',   '+44 7700 100004',  'Umbrella',   'Bronze',   'UK', true,  'Verified', '2023-08-11', 'https://backoffice.example.com/M004'),
  ('00000000-0000-0000-0000-000000000205', '00000000-0000-0000-0000-000000000001', 'M005', 'Priya',  'Sharma',    'psharma',   'priya@nakatomi.jp', '+81 90 0000 0005', 'Nakatomi',   'Gold',     'JP', true,  'Verified', '2020-03-07', 'https://backoffice.example.com/M005'),
  ('00000000-0000-0000-0000-000000000206', '00000000-0000-0000-0000-000000000001', 'M006', 'Carlos', 'Diaz',      'cdiaz',     'carlos@tyrell.com', '+1 415 000 0006',  'Tyrell',     'Silver',   'US', true,  'Pending',  '2023-04-22', 'https://backoffice.example.com/M006');

-- ─── Tickets ────────────────────────────────────────────────────────────────

insert into tickets (id, workspace_id, display_id, subject, customer_id, status_key, priority_key, category_key, assigned_user_id, sla_state, csat_score, csat_stars, csat_comment, csat_requested_at, csat_submitted_at, created_at, updated_at, resolved_at) values
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000001', 'TK-001', 'Payment not processing at checkout',  '00000000-0000-0000-0000-000000000201', 'escalated', 'urgent', 'Billing',   '00000000-0000-0000-0000-000000000101', 'breach', null, null, null, null, null, '2025-04-16 09:00+00', '2025-04-16 12:00+00', null),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000001', 'TK-002', 'Export transaction history to CSV',   '00000000-0000-0000-0000-000000000202', 'open',      'normal', 'Technical', '00000000-0000-0000-0000-000000000102', 'ok',     null, null, null, null, null, '2025-04-16 09:00+00', '2025-04-16 09:14+00', null),
  ('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000001', 'TK-003', 'Account locked after password reset', '00000000-0000-0000-0000-000000000203', 'open',      'high',   'Account',   '00000000-0000-0000-0000-000000000101', 'warn',   null, null, null, null, null, '2025-04-16 08:15+00', '2025-04-16 09:15+00', null),
  ('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000001', 'TK-004', 'Resend March 2025 invoice',           '00000000-0000-0000-0000-000000000204', 'pending',   'normal', 'Billing',   '00000000-0000-0000-0000-000000000103', 'ok',     null, null, null, null, null, '2025-04-16 07:00+00', '2025-04-16 10:00+00', null),
  ('00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000001', 'TK-005', 'GDPR data erasure request',           '00000000-0000-0000-0000-000000000205', 'gdpr',      'high',   'GDPR',      '00000000-0000-0000-0000-000000000101', 'warn',   null, null, null, null, null, '2025-04-15 14:00+00', '2025-04-15 14:00+00', null),
  ('00000000-0000-0000-0000-000000000306', '00000000-0000-0000-0000-000000000001', 'TK-006', 'Bulk user import feature request',    '00000000-0000-0000-0000-000000000205', 'resolved',  'low',    'Feature',   '00000000-0000-0000-0000-000000000105', 'ok',     4, 4, 'Quick acknowledgement and clear roadmap. Would have liked an exact ETA.', '2025-04-14 11:30+00', '2025-04-14 12:00+00', '2025-04-14 11:00+00', '2025-04-14 12:00+00', '2025-04-14 11:30+00'),
  ('00000000-0000-0000-0000-000000000307', '00000000-0000-0000-0000-000000000001', 'TK-007', 'iOS app very slow on iPhone 14',      '00000000-0000-0000-0000-000000000206', 'resolved',  'normal', 'Technical', '00000000-0000-0000-0000-000000000102', 'ok',     5, 5, 'James was incredibly responsive and the fix worked first try. Best support I''ve had.', '2025-04-14 13:30+00', '2025-04-14 14:00+00', '2025-04-14 10:00+00', '2025-04-14 14:00+00', '2025-04-14 13:30+00');

-- ─── Ticket messages ────────────────────────────────────────────────────────

insert into ticket_messages (workspace_id, ticket_id, role, author_user_id, author_label, body, created_at) values
  -- TK-001
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000301', 'customer', null, 'Sarah Mitchell',
   'Hi, I''ve been trying to checkout for the past hour but my payment keeps failing. Tried two different cards. I need this order urgently.',
   '2025-04-16 09:12+00'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000301', 'ai',       null, 'AI Agent',
   'Hi Sarah, I can see a temporary fraud-protection hold on transactions over £200 on your account. I''ve escalated this to our payments team for immediate review. In the meantime, could you try PayPal as an alternative? You should hear back within 30 minutes.',
   '2025-04-16 09:13+00'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000301', 'customer', null, 'Sarah Mitchell',
   'PayPal doesn''t work for me. This is really urgent, I have a deadline.',
   '2025-04-16 09:35+00'),
  -- TK-002
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000302', 'customer', null, 'James Reed',
   'I need to export all my transaction history to CSV for my accountant. Can''t find the option anywhere in the dashboard settings.',
   '2025-04-16 09:00+00'),
  -- TK-003
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000303', 'customer', null, 'Nina Kowalski',
   'I reset my password but now my account is locked. I have a client presentation in 2 hours and really need access.',
   '2025-04-16 08:15+00'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000303', 'agent',
   '00000000-0000-0000-0000-000000000102', 'James Webb',
   'Hi Nina, the lockout triggers automatically after 3 failed attempts during the reset flow — I''m unlocking it now. Please try again in 2 minutes.',
   '2025-04-16 08:22+00'),
  -- TK-004
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000304', 'customer', null, 'Tom Brewer',
   'Could you resend the invoice for March 2025? I''ve accidentally deleted the email and need it for our quarterly accounts.',
   '2025-04-16 07:00+00'),
  -- TK-005
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000305', 'customer', null, 'Priya Sharma',
   'I am formally requesting erasure of all my personal data under GDPR Article 17. Please confirm within the statutory timeframe.',
   '2025-04-15 14:00+00'),
  -- TK-006
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000306', 'customer', null, 'Priya Sharma',
   'It would be really helpful to import users in bulk via CSV rather than one by one. We have 200+ users to migrate.',
   '2025-04-14 11:00+00'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000306', 'ai',       null, 'AI Agent',
   'Thanks Priya — logged as high-priority. It''s on the Q3 roadmap and you''ll be notified when it ships.',
   '2025-04-14 11:01+00'),
  -- TK-007
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000307', 'customer', null, 'Carlos Diaz',
   'The mobile app is unusably slow on my iPhone 14. The dashboard takes 8+ seconds to load.',
   '2025-04-14 10:00+00'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000307', 'ai',       null, 'AI Agent',
   'Hi Carlos, we patched a performance regression affecting iOS 17 devices earlier today in v4.2.1. Could you update the app?',
   '2025-04-14 10:01+00');

-- ─── Manual tags on tickets ─────────────────────────────────────────────────

insert into ticket_tags (workspace_id, ticket_id, tag) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000301', 'billing'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000301', 'payment'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000302', 'export'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000302', 'data'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000303', 'account'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000303', 'login'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000304', 'invoice'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000304', 'billing'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000305', 'gdpr'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000305', 'erasure'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000306', 'feature-request'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000307', 'mobile'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000307', 'performance');

-- ─── AI tags ────────────────────────────────────────────────────────────────

insert into ticket_ai_tags (workspace_id, ticket_id, tag, confidence, accepted) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000301', 'urgent-billing',  94, false),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000301', 'checkout-issue',  87, false),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000302', 'data-export',     91, false),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000303', 'account-lock',    97, true),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000304', 'invoice-request', 99, true),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000305', 'gdpr-erasure',   100, true),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000306', 'feature-request', 95, true),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000307', 'mobile-bug',      88, true);

-- ─── Tag library ────────────────────────────────────────────────────────────

insert into tag_library (workspace_id, tag, kind, ai_confidence) values
  ('00000000-0000-0000-0000-000000000001', 'billing',          'manual', null),
  ('00000000-0000-0000-0000-000000000001', 'payment',          'manual', null),
  ('00000000-0000-0000-0000-000000000001', 'account-lock',     'ai',     97),
  ('00000000-0000-0000-0000-000000000001', 'data-export',      'ai',     91),
  ('00000000-0000-0000-0000-000000000001', 'gdpr-erasure',     'ai',    100),
  ('00000000-0000-0000-0000-000000000001', 'invoice-request',  'ai',     99),
  ('00000000-0000-0000-0000-000000000001', 'mobile-bug',       'ai',     88),
  ('00000000-0000-0000-0000-000000000001', 'feature-request',  'manual', null),
  ('00000000-0000-0000-0000-000000000001', 'urgent-billing',   'ai',     94),
  ('00000000-0000-0000-0000-000000000001', 'checkout-issue',   'ai',     87);

-- ─── Time entries ───────────────────────────────────────────────────────────

insert into time_entries (workspace_id, ticket_id, user_id, minutes, note, billable, created_at) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000306', '00000000-0000-0000-0000-000000000105', 25, 'Logged feature request, replied to customer',  true, '2025-04-14 11:05+00'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000307', '00000000-0000-0000-0000-000000000102', 45, 'Reproduced on iPhone 14, traced to image cache', true, '2025-04-14 10:30+00'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000307', '00000000-0000-0000-0000-000000000102', 30, 'Wrote test, deployed fix',                       true, '2025-04-14 13:15+00');

-- ─── Workflows ──────────────────────────────────────────────────────────────

-- Triggers + actions are stored as structured JSON now (vs the English prose
-- strings in data.js). The shapes below are a starting point — the evaluator
-- in the API will need to agree on the schema.
insert into workflows (workspace_id, display_id, name, trigger, action, status, run_count, last_run_at) values
  ('00000000-0000-0000-0000-000000000001', 'WF-001', 'Auto-escalate urgent billing',
   '{"all":[{"field":"priority","op":"eq","value":"urgent"},{"field":"category","op":"eq","value":"Billing"}]}'::jsonb,
   '{"type":"assign_role","role":"Senior Agent","then":{"type":"notify","target":"manager"}}'::jsonb,
   'active', 14, '2026-05-20 10:00+00'),
  ('00000000-0000-0000-0000-000000000001', 'WF-002', 'GDPR 72h SLA alert',
   '{"all":[{"field":"category","op":"eq","value":"GDPR"},{"field":"age_hours","op":"gt","value":72}]}'::jsonb,
   '{"type":"notify","target":"DPO","then":{"type":"flag"}}'::jsonb,
   'active', 3, '2026-05-19 12:00+00'),
  ('00000000-0000-0000-0000-000000000001', 'WF-003', 'Auto-resolve after 7 days',
   '{"all":[{"field":"status","op":"eq","value":"pending"},{"field":"last_updated_days","op":"gt","value":7}]}'::jsonb,
   '{"type":"set_status","value":"resolved"}'::jsonb,
   'inactive', 0, null),
  ('00000000-0000-0000-0000-000000000001', 'WF-004', 'Send CSAT survey on resolve',
   '{"any":[{"field":"status_change","op":"to","value":"resolved"}]}'::jsonb,
   '{"type":"send_email","template":"csat_survey"}'::jsonb,
   'active', 42, '2026-05-20 11:45+00');

-- ─── SLA policies ───────────────────────────────────────────────────────────

insert into sla_policies (workspace_id, display_id, name, priority_key, category_key, first_response_min, resolution_min, status) values
  ('00000000-0000-0000-0000-000000000001', 'SLA-001', 'Urgent · Billing',   'urgent', 'Billing',  15,  240,  'active'),
  ('00000000-0000-0000-0000-000000000001', 'SLA-002', 'Urgent · GDPR',      'urgent', 'GDPR',     30,  4320, 'active'),
  ('00000000-0000-0000-0000-000000000001', 'SLA-003', 'High · Default',     'high',   null,       60,  1440, 'active'),
  ('00000000-0000-0000-0000-000000000001', 'SLA-004', 'Normal · Default',   'normal', null,       240, 2880, 'active'),
  ('00000000-0000-0000-0000-000000000001', 'SLA-005', 'Low · Default',      'low',    null,       480, 7200, 'inactive');

-- ─── Assign rules ───────────────────────────────────────────────────────────

insert into assign_rules (workspace_id, display_id, name, priority, status, conditions, assignment, match_count, last_match_at) values
  ('00000000-0000-0000-0000-000000000001', 'AR-001', 'Urgent · Billing → Sofia', 1, 'active',
   '{"priority":"urgent","category":"Billing","vip":"all"}'::jsonb,
   '{"mode":"specific-agent","agent_user_id":"00000000-0000-0000-0000-000000000103"}'::jsonb,
   9, '2025-04-15'),
  ('00000000-0000-0000-0000-000000000001', 'AR-002', 'GDPR → Emma',              2, 'active',
   '{"priority":"all","category":"GDPR","vip":"all"}'::jsonb,
   '{"mode":"specific-agent","agent_user_id":"00000000-0000-0000-0000-000000000101"}'::jsonb,
   4, '2025-04-15'),
  ('00000000-0000-0000-0000-000000000001', 'AR-003', 'VIP gold → senior team',   3, 'active',
   '{"priority":"all","category":"all","vip":"Gold"}'::jsonb,
   '{"mode":"least-busy","team_user_ids":["00000000-0000-0000-0000-000000000101","00000000-0000-0000-0000-000000000103"]}'::jsonb,
   3, '2025-04-14'),
  ('00000000-0000-0000-0000-000000000001', 'AR-004', 'Default round-robin',     99, 'active',
   '{"priority":"all","category":"all","vip":"all"}'::jsonb,
   '{"mode":"round-robin","team_user_ids":["00000000-0000-0000-0000-000000000101","00000000-0000-0000-0000-000000000102","00000000-0000-0000-0000-000000000103","00000000-0000-0000-0000-000000000105"],"rr_index":0}'::jsonb,
   18, '2025-04-16');

-- ─── Canned responses ──────────────────────────────────────────────────────

insert into canned_responses (workspace_id, display_id, name, category, body) values
  ('00000000-0000-0000-0000-000000000001', 'TPL-001', 'Greeting',         'General', E'Hi {name},\n\nThanks for reaching out — I''ll take a look at this right away.'),
  ('00000000-0000-0000-0000-000000000001', 'TPL-002', 'Need more info',   'Triage',  E'To help me debug this, could you share:\n\n- Steps to reproduce the issue\n- The exact error message you''re seeing\n- A screenshot if possible'),
  ('00000000-0000-0000-0000-000000000001', 'TPL-003', 'Escalating',       'Triage',  'I''m escalating this to our specialist team — you should hear back within the hour.'),
  ('00000000-0000-0000-0000-000000000001', 'TPL-004', 'Resolution',       'General', 'I''ve resolved this for you. Please let me know if anything else needs attention.'),
  ('00000000-0000-0000-0000-000000000001', 'TPL-005', 'Refund processed', 'Billing', 'Your refund has been processed and should appear in 3-5 business days. Apologies for any inconvenience.'),
  ('00000000-0000-0000-0000-000000000001', 'TPL-006', 'CSAT request',     'General', 'When you have a moment, we''d appreciate your feedback on this ticket. Your rating helps us improve our support.');

-- ─── Ticket templates ──────────────────────────────────────────────────────

insert into ticket_templates (workspace_id, display_id, name, category, priority_key, subject, body) values
  ('00000000-0000-0000-0000-000000000001', 'TT-001', 'Password reset request',         'Account',   'normal', 'Password reset for [customer ID]',                  'Customer is unable to log in after attempting a password reset. Please verify identity, unlock the account if necessary, and confirm the reset email has been delivered.'),
  ('00000000-0000-0000-0000-000000000001', 'TT-002', 'Refund — duplicate charge',      'Billing',   'high',   'Duplicate charge — refund requested',               'Customer reports being charged twice for the same transaction. Verify in the payments system, raise a refund for the duplicate amount, and confirm via email when processed.'),
  ('00000000-0000-0000-0000-000000000001', 'TT-003', 'GDPR data erasure request',      'GDPR',      'high',   'Article 17 erasure request from [customer]',        'Formal GDPR Article 17 erasure request received. Acknowledge within 24h, run the erasure workflow, and confirm completion in writing within the statutory 30-day window.'),
  ('00000000-0000-0000-0000-000000000001', 'TT-004', 'Mobile app — performance issue', 'Technical', 'normal', 'Mobile app slow on [device]',                       'Customer reports the mobile app is unusably slow. Capture device model, OS version, and app build. Cross-reference against known performance regressions; escalate to mobile team if not on a patched build.'),
  ('00000000-0000-0000-0000-000000000001', 'TT-005', 'Feature request',                'Feature',   'low',    'Feature request: [short description]',              'Customer suggested a new feature. Capture the use case, expected behaviour, and any business impact. Add to the product backlog and acknowledge the customer with an expected review timeframe.');

-- ─── KB articles ───────────────────────────────────────────────────────────

insert into kb_articles (workspace_id, display_id, title, category, body, author_user_id, updated_at) values
  ('00000000-0000-0000-0000-000000000001', 'KB-001', 'How to reset your account password',          'Account',         E'Lost access to your account? Follow these steps to regain it.\n\nStep 1: Click "Forgot password?" on the sign-in screen.\n\nStep 2: Enter your work email address and submit. The reset link is sent only to addresses on your organisation''s allowlist.\n\nStep 3: Check your inbox for a reset link. The link expires after 30 minutes.\n\nStep 4: Set a new password — minimum 12 characters, must include a number and a symbol.\n\nIf you don''t receive an email within 5 minutes, check your spam folder. If it''s still missing, contact your administrator — your account may be temporarily locked after multiple failed attempts.', '00000000-0000-0000-0000-000000000101', '2025-04-10 00:00+00'),
  ('00000000-0000-0000-0000-000000000001', 'KB-002', 'Understanding SLA breach alerts',             'Best Practices',  E'SLA breaches indicate tickets that have exceeded their contractual response or resolution window. They appear as red badges in the ticket list, in the notifications bell, and on the dashboard KPI bar.\n\nWhen an SLA is in "warn" state, the ticket is approaching but has not yet missed its deadline. When it moves to "breach", customer-facing escalation paths typically engage automatically depending on workflow rules.\n\nTo prioritise effectively: filter the Tickets page by SLA status, then sort by Updated descending. Reach out to the customer first, then update the ticket status to acknowledge the breach internally.', '00000000-0000-0000-0000-000000000102', '2025-04-12 00:00+00'),
  ('00000000-0000-0000-0000-000000000001', 'KB-003', 'Submitting a GDPR data erasure request',      'GDPR',            E'Customers in the EU/UK have the right to request erasure of their personal data under Article 17 of the GDPR.\n\nWhen a ticket is flagged with category GDPR, the ticket sidebar exposes three actions: Request Erasure, Redact Data, and SAR Export.\n\nErasure is a hard delete and is irreversible. Redaction masks identifying fields in the ticket thread but preserves the audit trail. SAR Export packages all data held about the customer into a downloadable archive within 30 days, as required by law.\n\nAll GDPR actions are logged with the requesting agent''s name and timestamp.', '00000000-0000-0000-0000-000000000103', '2025-03-28 00:00+00'),
  ('00000000-0000-0000-0000-000000000001', 'KB-004', 'Exporting transaction history to CSV',        'Technical',       E'Customers can export their transaction history as CSV from the customer portal.\n\nIn the agent UI, open the customer''s profile from any ticket sidebar, then use the "Export" action. The CSV will be emailed to the customer''s verified address within a few minutes.\n\nIf the customer reports the file did not arrive, first verify the email address is correct, then check whether the export job timed out — exports for accounts with more than 50,000 transactions are generated overnight.', '00000000-0000-0000-0000-000000000104', '2025-04-05 00:00+00'),
  ('00000000-0000-0000-0000-000000000001', 'KB-005', 'Setting up the Claude API key for AI Draft',  'Getting Started', E'The "AI Draft" button in the ticket composer uses the Anthropic Claude API to draft a reply based on the conversation history.\n\nTo enable it:\n\n1. Go to Settings → AI Assistant.\n2. Paste your Claude API key in the API key field. It should start with "sk-ant-".\n3. Choose a model. Sonnet 4.6 is the default and a good balance of speed and quality.\n\nThe key is stored locally in your browser via localStorage. It is never transmitted to our servers — requests go directly from your browser to api.anthropic.com.\n\nIf the API rejects your request, the composer surfaces the error message returned by Anthropic.', '00000000-0000-0000-0000-000000000101', '2025-04-15 00:00+00'),
  ('00000000-0000-0000-0000-000000000001', 'KB-006', 'Creating custom roles and permissions',       'Best Practices',  E'Out of the box, this workspace ships with Admin, Senior Agent and Read Only roles. You can extend this for your team''s needs.\n\nTo add a permission: Roles & Permissions → "+ Permission". Pick a label and an internal key. The new permission is added as a column on every existing role with default off.\n\nTo add a role: Roles & Permissions → "+ Role". Optionally copy the permissions of an existing role as a starting point.\n\nThe Admin role is protected — you cannot delete it, and the Roles & Permissions toggle on the Admin row is locked on to prevent accidental self-lockout.', '00000000-0000-0000-0000-000000000101', '2025-04-08 00:00+00'),
  ('00000000-0000-0000-0000-000000000001', 'KB-007', 'Resending invoices and billing documents',    'Billing',         E'Customers occasionally request a resend of their invoice or other billing documents.\n\nFor invoices from the current and previous quarter, use the customer portal action — these are regenerated on demand.\n\nFor older documents, raise an internal billing ticket with the customer ID and the invoice month. The finance team typically responds within one business day.\n\nNever attach billing documents directly to support tickets — always send via the secure document portal to maintain the audit trail.', '00000000-0000-0000-0000-000000000105', '2025-04-02 00:00+00');

-- ─── Custom fields ─────────────────────────────────────────────────────────

insert into custom_fields (workspace_id, entity_type, key, label, field_type, required, default_value, sort_order) values
  ('00000000-0000-0000-0000-000000000001', 'customer', 'account_manager', 'Account Manager', 'text',   false, '',  10),
  ('00000000-0000-0000-0000-000000000001', 'customer', 'contract_value',  'Contract Value',  'number', false, '',  20),
  ('00000000-0000-0000-0000-000000000001', 'customer', 'renewal_date',    'Renewal Date',    'date',   false, '',  30);

-- ─── Business hours ────────────────────────────────────────────────────────

-- Sensible UK defaults: Mon–Fri 09:00–18:00, weekends off, no holidays.
insert into business_hours (workspace_id, enabled, days, holidays) values
  ('00000000-0000-0000-0000-000000000001', true,
   '[
     {"label":"Mon","enabled":true,"start":"09:00","end":"18:00"},
     {"label":"Tue","enabled":true,"start":"09:00","end":"18:00"},
     {"label":"Wed","enabled":true,"start":"09:00","end":"18:00"},
     {"label":"Thu","enabled":true,"start":"09:00","end":"18:00"},
     {"label":"Fri","enabled":true,"start":"09:00","end":"18:00"},
     {"label":"Sat","enabled":false,"start":"09:00","end":"18:00"},
     {"label":"Sun","enabled":false,"start":"09:00","end":"18:00"}
   ]'::jsonb,
   '{}');

