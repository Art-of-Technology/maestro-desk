-- Retain the acknowledged payload so a changed filter in an old browser tab
-- is not discarded merely because its original ID was already transferred.
alter table kb_filter_transfers add column source_payload jsonb;
