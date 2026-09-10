# Unassigned ticket alerts

The notification bell and Notifications page show a separate alert for every
unassigned open, pending, escalated or GDPR ticket in the current workspace.
The existing complete outstanding-ticket index supplies the records, including
pages not yet loaded in the ticket list. SLA and escalation alerts remain visible.

Assignment, completion, merge or deletion removes the alert after synchronization.
Snoozed tickets return when their snooze expires. The existing realtime signals
and 60-second polling fallback refresh both open notification surfaces. Queue
loading and errors are explicit, with a retry action instead of an empty success.

The preference defaults on, including for existing saved preferences. It uses
the existing browser-local notification settings. Read/dismiss flags follow the
existing session-only behaviour; leaving the unassigned queue resets those flags
so a subsequent return is unread. These are in-app alerts, not email or push.

## Validation — 10 September 2026

- API typecheck and all 645 API tests pass against isolated local Postgres.
- 38 frontend tests pass, including seven new unassigned-alert tests.
- Build, bridge collision, import audit, header sync, 24 route smokes and seven
  ticket-detail smokes pass.
- `scripts/unassigned-browser-check.mjs`: 16 native-module browser checks pass.
  Uses 205 fixture tickets, confirms full pagination, all work statuses,
  escalation coexistence, assignment/completion/snooze transitions, read reset,
  failed load/retry, settings persistence, open bell refresh, actual list-sync
  integration and workspace change. All API calls are intercepted locally.
- Manual code review covered the full-index completion callback, stale-load
  guards, workspace/session separation, reliable assignment UUID mapping,
  escaping, rerender recursion and notification preference migration.
- UI review: native buttons support keyboard ticket opening; notification
  settings have accessible names; cards wrap controls in narrow space. Existing
  application shell limitations at phone widths remain outside this feature.
- Tracked-file credential scan: zero strong credential patterns; no tracked
  non-example environment files. No database migration or environment change.

Live deployment and acceptance evidence will be attached to the pull request.

## Follow-up found during review

`bulkAssignTickets` in `web/js/tickets/list.js` changes local ticket objects and
the local activity log but does not persist assignment through the API. A separate
fix should make bulk assignment persist and report partial failures. This feature
uses actual assignment UUIDs so that a local-only bulk change cannot incorrectly
clear an ownership alert.
