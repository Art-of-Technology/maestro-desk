-- Deploy the schema-compatible API (PR #482) before applying this migration.
-- The runner wraps this file in a transaction. Match the API's lock order so
-- journal cleanup cannot deadlock with an in-flight merge or erasure.
set local lock_timeout = '10s';
set local statement_timeout = '60s';
lock table customers in access exclusive mode;

-- Repair journals belonging to subjects erased before journal PII cleanup was
-- implemented. Preserve non-personal backfills and the merge history itself.
update customer_merges m
set backfilled_fields = m.backfilled_fields - array[
  'first_name', 'last_name', 'username', 'email', 'mobile', 'backoffice_url',
  'kyc_status', 'jurisdiction', 'maestro_user_id', 'maestro_member_id'
]::text[]
from customers c
where c.id = m.source_customer_id and c.workspace_id = m.workspace_id
  and c.erased_at is not null;

-- Retire obsolete KYC copies for every subject, including old unmerged rows.
update customer_merges set backfilled_fields = backfilled_fields - 'kyc_status'
where backfilled_fields ? 'kyc_status';

alter table customers drop column if exists kyc_status;
