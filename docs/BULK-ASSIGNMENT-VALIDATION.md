# Persistent bulk ticket assignment

Bulk Assign now calls the existing ticket PATCH endpoint for each selected
ticket. The agent selector uses user UUIDs, excludes inactive agents and shows
email addresses when names are duplicated. No API contract, migration or
environment change is required.

Only a confirmed response updates the local assignment and removes that ticket
from the selection. Errors remain visible in the dialog with a retry action for
failed tickets only. Requests run sequentially, with duplicate submissions
blocked. Closing the dialog or changing the session/workspace stops remaining
requests; an already-sent request may complete in its original workspace.

## Validation — 10 September 2026

- Five batch tests: sequential confirmation, partial failure/retry, malformed
  responses, stale success/error responses and cancellation before submission.
- `scripts/bulk-assignment-browser-check.mjs`: 16 native-module checks, including
  inactive/duplicate-name agents, held requests, duplicate clicks, no premature
  assignment, partial failure, retry, complete-index refresh, page reload and
  workspace change during a request. All API calls are intercepted locally.
- Frontend regression tests, build, import/collision/header guards, 24 route
  smokes and seven ticket-detail smokes pass.
- Manual code review covered request scope, identity checks, detached modal
  handling, selection snapshots, response validation, output escaping and the
  existing API's active-workspace-member validation.
- Dialog reviewed at 1280px and 390px; labelled native agent selector, disabled
  saving controls and status text remain readable without modal overflow.
- Tracked-file credential scan found zero strong credential patterns and no
  tracked non-example environment files.

Final API test, CI, Octopus and deployment/live results are recorded on the PR.

## Separate follow-up

Bulk priority changes and bulk tag additions in `web/js/tickets/list.js` also
modify browser objects without persisting through the API. They should receive
the same persistence and partial-failure treatment in a separate approved fix.
