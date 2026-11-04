# Send and resolve after confirmed delivery

The browser previously sent the reply and then made a separate status request.
Navigating away could skip that request. A later delivery receipt updated the
email without completing the selected status action. Sent replies were also
absent from both activity views.

The reply now saves its selected status and reason on the server before sending.
The send acknowledgement, an explicit retry of a refused email, or a delivery
receipt completes that action. The status, status history and completion marker
commit together. Repeated receipts cannot repeat resolution or its survey.
Normal Send, internal notes, and the separate Send & close flow retain their
existing behaviour.

The saved action uses the original verified author. Completion rechecks current
workspace access, ticket visibility, status permissions, active status/reason,
privacy, conversation changes and intervening status history. A stale action is
marked for review instead of overwriting newer work. Email details show pending,
completed and review-required actions. Transient completion failures retain the
confirmed email and pending action; repeated receipts can retry completion.
There is no new background polling job. Agents can review the current ticket and
change its status independently without resending the reply.

Both activity views read confirmed sends from the saved message metadata, using
the message ID as a stable event ID. This includes historical confirmed sends
without inserting retrospective audit entries. The timestamp uses the saved
send time, falling back to message creation for older records without one.

## Verification

- Isolated PostgreSQL 17 database, all repository migrations applied.
- 91 API tests passed across agent replies, permanent activity, lifecycle history
  and role permissions. The final conversation-count guard passed all eight
  focused status-action tests (61 assertions).
- 36 frontend tests passed (317 assertions).
- 103 headless Chromium checks passed at desktop and mobile widths, including
  the existing composer, new-ticket form, plain Send, manual status recovery,
  and navigating to another ticket while the send response is held.
- Frontend build, API typecheck, bridge collision check, import audit,
  25 route smokes, seven ticket-detail smokes, and diff whitespace check passed.
- One broader run and one focused run encountered wall-clock timeouts. Both
  affected tests passed when rerun; no timeout thresholds were increased.
- All mail and survey provider responses were simulated. No production records
  were changed and no customer email was sent.

## Security review

**Stack:** Hono / TypeScript / postgres.js. **Scope:** this change's send action,
delivery webhook completion, activity queries and UI rendering.

| Severity | Finding | Resolution |
| --- | --- | --- |
| None open | Access, stale actions, lock order and duplicate completion reviewed | Current permissions and visibility rechecked; ticket/message locks serialize status writes; receipt committed before completion; message lock uses NOWAIT against an in-flight acknowledgement. |

Dependencies: `bun audit --production` reported no vulnerabilities. Semgrep and
Gitleaks were unavailable; the diff was manually checked for unsafe queries,
unescaped output, credential additions and sensitive logging. SQL parameters
remain bound, status-action input is allowlisted, and status labels are escaped.
This was a focused change review, not a full application penetration test or a
production load test.

## Release and existing tickets

Deploy the API before the frontend and reload open browser tabs. No database
migration, dependency or additional secret is needed. If a new browser reaches
an older API, it warns that the status action was not completed rather than
silently claiming resolution.

Existing confirmed replies appear in activity after deployment. Historical
messages have no saved status action, so this change does not automatically
resolve old tickets. For an already-delivered reply such as TK-202, review the
current ticket and use its status control without sending the reply again.
Production rollout and live acceptance remain outstanding.
