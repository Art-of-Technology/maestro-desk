-- Keep references to already-retained player audit rows, not another copy of
-- the player identifier or narrative. Existing audit hashes remain untouched.
alter table gdpr_erasures add column retained_player_audit_ids uuid[] not null default '{}';
