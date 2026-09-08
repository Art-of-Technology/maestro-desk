# Legacy KYC retirement

The product no longer uses `customers.kyc_status`. Remove its stored values in
two releases so the previous API image remains usable after the schema changes.
`customers.mobile` remains the primary-contact mirror and is not retired.

## Release 1: schema compatibility

Export, erasure, merge and unmerge detect the legacy field from the customer row.
They continue handling its values while the column exists, and work without it.
Erasing a source also removes all its personal-data copies from merge journals,
including earlier unmerged entries, while preserving other backfills and history. Customer locks
keep the schema observation valid until merge/erasure transactions commit.

Validation on local PostgreSQL 17, 2026-09-08:

- Typecheck passed.
- Full API suite: 580 passed with the column, 580 passed after dropping it in a
  separate disposable database. CI repeats both states and asserts which ran.
- Coverage includes export, merge/unmerge, old journal entries, merged-source
  erasure, and preservation of mobile contact behavior.
- Frontend: 17 URL tests; build, bridge, import and header checks; 24 route and
  seven ticket-detail smokes passed.
- Manual review checked workspace scoping, dynamic SQL allowlists, table locks,
  output field filtering and journal erasure. No unresolved findings.

Deploy this release and verify its exact commit and customer export before
shipping the migration. This release does not change the production schema.

## Release 2: physical retirement

Add a new migration that removes KYC keys from every merge journal and drops the
customer column in one transaction. Lock customers before journals to match API
lock ordering; bound lock waits. Test a fresh migration run, upgrade, rerun and
the compatibility release against the resulting schema before deployment.

After retirement, rollback is to release 1 or newer. Earlier API images reference
the removed column directly and cannot serve this schema. An application rollback
does not restore retired KYC values.
