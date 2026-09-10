# Manual customer creation — 10 September 2026

The live New Customer form previously appended a browser-only row. The row had
no API UUID and vanished on refresh. This was reproduced during the TK-63
acceptance walkthrough with a temporary profile that had no email address.

The form now creates profiles through POST /api/v1/customers in authenticated
workspaces. The server assigns the display ID and persists the customer and its
primary contact together. Existing primary or secondary email ownership produces
a 409, including concurrent requests. Manual creation does not assert marketing
consent, player identity, VIP status, username or customer-since date.

The UI uses the server's row mapper, guards concurrent clicks and session/workspace
changes, preserves form values on errors, and keeps local-only behavior for demo
mode. Brand is a profile label; workspace ownership comes only from authentication.

## Validation

- API typecheck and 628 tests passed on local PostgreSQL 17 with legacy KYC absent.
- New database tests cover durable reads, primary contacts, same-email isolation
  across workspaces, nonmember denial, forbidden fields, concurrent duplicates,
  secondary-address conflicts, no-email profiles, and merge/unmerge.
- Native-module browser fixture `scripts/customer-create-browser-check.mjs`
  covers empty-workspace API persistence, server UUID/display ID mapping,
  double-click guarding, duplicate errors, preserved form values and late
  responses after a workspace switch.
- Frontend build, bridge/import/header guards, 24 route and seven detail smokes
  passed. No database migration or dependency change is required.
- Manual review checked authenticated workspace predicates, strict input fields,
  parameterized SQL, transaction rollback, contact ownership, consent defaults,
  stale modal/session handling and customer mapping. No unresolved findings.

Deploy API before web. Record the live create/refresh and merge/unmerge walkthrough
on the PR after deployment. Reply-To routing is a separate pending change; this
fix does not change any email header or send test emails.
