# Permanent ticket lifecycle history

Status changes, snooze changes and assignment-rule decisions now write ticket activity and a tamper-evident audit record in the same transaction as the change. Records use server timestamps and authenticated actors; customer replies and automatic expiry use explicit system sources. Rule IDs/names and previous/new assignees are snapshotted.

## Coverage

- Status PATCH, closure, customer replies reopening pending/resolved/closed tickets, and merge/unmerge.
- Snooze/resnooze (including reason changes), manual wake, verified expiry, and snooze clearing during closure.
- Automatic assignment at intake and explicitly running rules. Ticket updates, rule counters and round-robin state commit together. Existing intake callers retain their best-effort assignment behaviour if the engine fails.
- Ticket detail and the Activity Log display saved records, with status/snooze filters. Live status, snooze and assignment changes no longer add a second browser-only record. Merge/unmerge status history uses the saved response; other existing merge annotations remain unchanged.
- Existing closure messages and the internal archive on customer reopening are preserved. Closure guidance now correctly says customer replies reopen tickets.

Unchanged values produce no new history. This is not request-key deduplication: explicitly rerunning a round-robin rule can select another agent and is recorded as another change.

Expiry remains processed through the existing browser wakeup path. The server verifies that the current snooze has actually expired while holding the ticket lock, so an outdated wakeup cannot clear a future snooze. This change does not add a background scheduler or reconstruct historical events.

## Validation

- API typecheck passed.
- Complete API suite: **661 tests passed**, 79 files, on the isolated local PostgreSQL 17 database (not production).
- Targeted lifecycle/history/date tests: **21 passed**, including 9 new lifecycle tests. Covers concurrent status updates, closure retries and audit snapshots, customer reopening, reason-only snooze edits, repeated and stale wakeups, reverse simultaneous merges, concurrent round-robin assignment, forced audit failure rollback, tenant isolation and audit-chain verification.
- Frontend unit suite: **52 passed**.
- Native browser lifecycle test: **15 checks passed**, exercising status, snooze, stale expiry response, manual wake, running assignment rules, closure, saved actor/timestamps, snoozed-by name, escaped text, full reload and both new Activity Log filters.
- Existing native browser history test: **13 checks passed**, including responsive rendering, pagination, exact ticket links and workspace switching.
- Existing queue refresh regression: **17 checks passed**.
- Frontend build, bridge/import checks, matching security headers, **24 route smokes** and **7 ticket detail smokes** passed.
- Focused manual code review: checked transaction boundaries, stable lock ordering for merge pairs/rules, server-controlled attribution, response consistency, parameterised queries, tenant predicates and escaped display strings. No unresolved findings in the changed paths. No dependencies or migrations added.
- Credential-pattern scan: zero strong credential hits and no tracked non-example environment files. This is a focused change review, not a new whole-project security audit.

PR review and live deployment evidence are recorded on the pull request after release.
