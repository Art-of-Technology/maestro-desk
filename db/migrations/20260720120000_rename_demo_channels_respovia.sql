-- Rebrand the demo-seed channels from "Maestro Desk" to "Respovia".
-- The original demo seed (20260520121500_seed_demo.sql) is already applied in
-- dev environments and must not be edited, so this rewrites the same rows in
-- place. Every UPDATE is guarded on the demo workspace/channel ids AND the old
-- value, so it is a no-op in production (no demo seed) and in databases where
-- the demo rows were already customized or dropped.

update channels
   set address = 'support@respovia.com',
       signature = '— Respovia Support'
 where id = '00000000-0000-0000-0000-000000000c01'
   and workspace_id = '00000000-0000-0000-0000-000000000001'
   and address = 'support@maestrodesk.com';

update channels
   set address = 'billing@respovia.com',
       signature = '— Respovia Billing'
 where id = '00000000-0000-0000-0000-000000000c02'
   and workspace_id = '00000000-0000-0000-0000-000000000001'
   and address = 'billing@maestrodesk.com';

update channels
   set address = 'respovia.com/help/contact'
 where id = '00000000-0000-0000-0000-000000000c03'
   and workspace_id = '00000000-0000-0000-0000-000000000001'
   and address = 'maestrodesk.com/help/contact';

update channels
   set signature = 'Hi! Respovia live chat — how can we help?'
 where id = '00000000-0000-0000-0000-000000000c04'
   and workspace_id = '00000000-0000-0000-0000-000000000001'
   and signature = 'Hi! Maestro Desk live chat — how can we help?';
