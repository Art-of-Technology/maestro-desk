# Permanent ticket change history

Assignment and priority edits, manual tag additions/removals, and acceptance of
AI tag suggestions now record activity and audit entries in the same database
transaction as the change. This covers individual edits and the bulk actions
that use these endpoints. Unchanged values and repeated tag requests add no
history entries. Row locks ensure concurrent edits record the actual preceding
value. Actor identity comes from authentication, timestamps from PostgreSQL,
and actor/assignee names are copied into the entry at the time of the change.

The authenticated Activity Log reads server records with cursor pagination,
server-side filters, and exact ticket filtering from “View all activity”. It
also retains ticket creation and existing customer notes as persisted sources.
Customer-note authors retain that source's existing current-name behavior;
snapshot names apply to the newly recorded ticket change events. Deleted
tickets/customers are excluded from the feed. The protected audit chain remains
separate from the user-facing feed.

No database migration is required. Existing activity and audit tables are reused.
Older browser-only changes cannot be recovered. Automatic assignment rules and
other action types retain their existing behavior and are outside this change.

## Validation — 10 September 2026

- API typecheck and 652 tests pass against the isolated PostgreSQL 17 test DB.
- New database tests exercise actual authenticated routes: multi-field edits,
  actor/assignee snapshots after a rename, concurrent priorities, concurrent
  duplicate tag requests, removal retries, AI-tag acceptance retries, rollback
  on audit failure, cross-workspace access, pagination and audit-chain verification.
- 52 frontend unit tests pass, including history deduplication/reload and the
  existing bulk-save regression suite.
- App build, bridge collision, import audit and security-header checks pass.
- All 24 route and seven ticket-detail smokes pass.
- Native ES-module browser checks: 12 history checks, 19 bulk priority/tag
  checks, and 16 bulk assignment checks pass. Local browser fixtures intercept
  API requests; production acceptance is recorded separately on the PR.
- The regression suite caught an early-returned survey timestamp. The response
  now reads delivery timestamps after the mailer completes while preserving the
  assignment/priority values confirmed by the transaction. Both survey tests pass.
- Live acceptance caught activity links mixing readable workspace slugs with
  UUID record IDs. Links now use display numbers with workspace slugs and UUIDs
  with legacy workspace UUIDs. The browser regression follows the link to a
  previously unloaded ticket and checks both URL formats.

## Code and security review

Reviewed the changed routes, transaction helper, frontend response handling,
activity feed, and tests. No unresolved correctness or security findings.

- Every new feed source and activity read is scoped to the authenticated
  workspace; ticket joins also exclude deleted records.
- Query parameters are validated, SQL values parameterized, and page sizes
  bounded. Cursors preserve database timestamp precision.
- Event text, references and actor labels are escaped. Links use the existing
  route formatter and authenticated record loader, including unloaded tickets.
- Late responses from another workspace or old filters are discarded.
- History failure rolls back the state change. Audit inserts use the existing
  append-only hash-chain trigger, whose verification test passes.
- Strong credential scan: zero hits, no tracked non-example environment files.
- No dependencies changed. Semgrep and Gitleaks are unavailable; this is a
  focused manual review plus existing guards, not a full project security audit.

## Design review

Vanilla ES-module Activity Log, desktop screenshot and DOM checks at 390, 768,
and 1280 pixels. Score: 4/5; no unresolved findings in the changed controls.

- Native links/buttons, labelled filters, loading/error/retry and empty states.
- Minimum height of new filter/action controls: 32px. Explicit focus outlines.
- No main-area overflow at the three viewports; the table scrolls horizontally.
- Secondary text contrast against its measured surface: 6.20:1. Existing design
  tokens and button/table styles are reused; no new palette or font is added.
- UI copy reviewed for plain wording; event counts explicitly say “loaded”.

## Release

Merge only after CI and the required Octopus score of at least 4/5. Deploy the
merged commit to the API and web applications through the existing Dokploy
configuration, then verify with disposable tickets and remove the fixtures.
