# Server-managed snooze expiry

The production Node API now starts a snooze worker alongside its existing webhook worker. It scans immediately at startup and every minute, so expiry no longer depends on an agent leaving Respovia open. Local development starts the same worker; importing the API in tests or serverless previews does not start it.

## Behaviour and operations

- Each sweep handles at most 100 candidates and stops starting tickets after 30 seconds. Larger backlogs continue on later sweeps. A rotating, microsecond-precise scan cursor prevents failed or locked tickets from indefinitely blocking later candidates.
- Only expired open, pending, escalated and GDPR tickets qualify. Deleted, merged, completed and future-snoozed tickets are excluded, including from older clients' automatic-wake requests.
- Each ticket is rechecked under its own row lock. Clearing its snooze, stamping the wake time, ticket activity and the tamper-evident audit record commit together. Concurrent workers, legacy browser wakeups and manual edits use the same helper.
- A failed ticket rolls back and is retried on a later sweep. Other candidates continue. Logs include IDs/error codes without ticket content; the existing deduplicated operations-alert path reports job failures.
- The sweep does not overlap itself. Shutdown cancels further work and drains the current sweep alongside HTTP requests, within the existing nine-second process shutdown deadline. Individual mutation statements have a five-second timeout.
- Realtime signals are emitted after commit; cursor sync remains the fallback. The full work index and ticket detail restore the saved wake marker. Live browser timers no longer send automatic wake requests; manual wake and local demo expiry remain available.
- Wake notifications retain the existing preferences and 24-hour display window. Their identity includes ticket UUID and wake time, so dismissing one snooze cycle does not hide a later one. Completed or newly snoozed tickets do not show stale wake alerts.

No new external scheduler, service or secret is required. Dokploy continues to boot `src/server.ts`. Nightly GitHub Actions jobs are unchanged. The additive migration `20260910140000_snooze_expiry_index.sql` creates a partial index over snoozed outstanding tickets; it changes no ticket data. Index rollback, if needed: `drop index tickets_pending_snooze_expiry_idx;` (the previous application version tolerates the index).

## Validation

- Migration applied successfully to the isolated PostgreSQL 17 database.
- API typecheck and complete suite: **669 tests across 80 files** passed.
- Eight worker tests cover immediate startup, no overlapping ticks, graceful stop, failure reporting/retry, browser-independent expiry across workspaces, exclusions, concurrent workers and old clients, audit rollback and verification, resnoozing under lock, and a full locked batch with later eligible work.
- Frontend unit suite: **56 tests** passed, including saved wake restoration, stable/repeated-cycle IDs, exclusions and time-window boundaries.
- Native browser checks: **39 passed** (8 server-snooze, 15 lifecycle, 16 unassigned). The new test verifies zero automatic browser wake requests, server-state refresh beyond the first 200 tickets, dismissal followed by another snooze, reload/login restoration and completion removing the alert.
- Build, bridge/import/header guards, **24 route smokes** and **7 ticket detail smokes** passed.
- Focused review checked cross-workspace worker selection, tenant-scoped mutations and realtime channels, lock/retry behaviour, timestamp precision, shutdown, parameterised queries and notification escaping. No unresolved findings. Credential-pattern scan: zero strong matches; no tracked non-example environment files. No new dependencies.

Octopus review and production acceptance/cleanup evidence will be recorded on the PR after release.
