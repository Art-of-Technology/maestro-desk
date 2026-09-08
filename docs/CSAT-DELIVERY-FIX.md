# Survey delivery repair

Resolving TK-58 on 8 September 2026 sent `csat_requested_at` from the browser
before the server called the survey mailer. The mailer treated the date as a
previous send. Postmark confirmed there was no survey message. The manual
Send satisfaction survey action also only wrote a date.

The mailer now owns the requested timestamp. PATCH accepts but ignores the old
browser field, and returns the actual survey outcome. Manual sending calls the
authenticated, workspace-scoped `POST /tickets/:id/csat` endpoint on resolved
tickets. Failure leaves the button available for retry; success displays the
server date. No mail-provider details or survey tokens are returned by these
mutation endpoints.

A database claim serializes simultaneous sends across API instances. It expires
after ten minutes if a process crashes, and its unique ID prevents an old sender
from releasing a newer claim. Normal failure releases the claim immediately.
This is duplicate prevention for concurrent requests, not exactly-once delivery:
a provider acceptance followed by a process/database failure remains ambiguous.

The migration clears historical requested dates only where there is no token,
submission timestamp, score or star rating. It does not send email. Actual
accepted surveys and recorded ratings remain intact.

Validation: 593 API tests passed before the extra migration test; the final
focused suite passes 21 tests / 123 assertions including that migration test.
API typecheck, frontend build, bridge/import/header guards, 17 URL tests, 24
route and seven detail smokes pass. The new migration applies on PostgreSQL 17
under Node 22. Native browser modules confirm Resolve sends only status, a
failure leaves the requested date empty, and manual retry calls POST /csat,
uses the server timestamp and does not open the demo rating modal.

Focused code/security review covers workspace predicates, authentication,
rate limiting, recipient opt-outs/suppression, token redaction and claim release.
The UI uses the existing status toast and button styles. No unresolved findings.

TK-58 was retried separately on production at 14:51 UTC after clearing its false
marker. Postmark accepted the survey to the approved test recipient. Receipt
and submission still need user confirmation. This operational retry predates
the code deployment and is not evidence that the new UI is deployed.
