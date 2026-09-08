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

Migration `20260908124500_retire_legacy_kyc.sql` removes KYC keys from every merge
journal and drops the customer column in one transaction. It also removes other
personal-data keys from journals whose source was erased before release 1.
Other backfills and all journal rows are preserved. Customers are locked before
journals to match API lock ordering, with a 10-second lock timeout and a 60-second
statement timeout. Runtime schema compatibility remains in place.

Release 1 merged as `5afd5a9b459d1b3edb79963f066f3927d4ff23f3` (PR #482).
Local release 2 validation on PostgreSQL 17:

- Node 22 applied all 88 migrations to a fresh database; Bun rerun was a no-op.
- Upgrade from the legacy schema applied the single pending migration.
- 581 API tests passed on both fresh and upgraded databases, including a migration
  regression that checks reruns, workspace matching, erased and active journals,
  retained history, mobile and VIP values.
- Release 1 commit `f6d915d9a6f7d778a2d94fd72c9d7bd848264851` passed its 580 tests
  against the actual upgraded database, verifying the rollback image.
- Typecheck, frontend build and guards, 17 URL tests, 24 route smokes and seven
  ticket-detail smokes passed. Manual review found no unresolved issues.

After retirement, rollback is to release 1 or newer. Earlier API images reference
the removed column directly and cannot serve this schema. An application rollback
does not restore retired KYC values.
