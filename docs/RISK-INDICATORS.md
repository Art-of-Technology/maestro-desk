# Customer risk indicators

The profile panel reads `GET /api/v1/customers/:id/risk`. Complaint counts cover
the full customer history in the authenticated workspace, not the tickets loaded
in the browser. The category key is `Complaints` (case-insensitive). Open means a
non-terminal workspace status; the separate 30-day count uses ticket creation
time, including closed complaints. Deleted and merged-away tickets are excluded.

AML is fetched live using the workspace's Maestro brand and the customer's linked
Member ID. Space Casino's backoffice verified `0 = Low`, `1 = Medium`, `2 = High`
on 8 September 2026. This mapping is limited to that brand. Missing, unknown,
mismatched and failed responses display Unavailable. RG, CDD and closed-account
data remain unavailable; a generic account status is not a closure signal.

No risk value is persisted locally or added to AI prompts. The read audit records
the `aml` category, without its value. HTTP responses use `no-store`. Lookups that
finish after erasure, merge or relinking discard the old identity's result.

## Validation

PostgreSQL 17: all 587 API tests pass, including full-history counts, custom
terminal statuses, exclusions, cross-workspace denial, unknown/provider failures
and erasure during lookup. Existing tests still assert AML stays out of prompts.
Frontend build, bridge/import/header guards, 17 URL tests, 24 route and seven
ticket-detail smokes pass. Native-module browser checks cover load, error, retry,
navigation and logout during a delayed response. The panel fits 390, 768 and
1280px viewports without horizontal overflow.

Focused security review: parameterized, workspace-scoped reads; server-derived
brand/member identity; no-store responses; audit categories without values.
Focused design review: existing tokens, text-based states, keyboard-accessible
Refresh, 44px mobile target, and measured text contrast above 4.5:1. No unresolved
findings. This is a diff review, not a repository-wide scanner audit.

## Maestro contract request — draft, not sent

Please confirm the brand-scoped member-risk contract for Respovia:

- AML: confirm the `attributes.amlRiskLevel` mapping and whether it differs by
  brand. Space Casino currently uses Low/Medium/High values 0/1/2 in backoffice.
- RG: provide the supported endpoint, fields, enums and required scope for
  responsible-gambling restrictions and self-exclusion. The previous
  `/api/v1/proxy/members/{id}/rg` path still returned 404 on 8 September 2026.
- CDD: provide the review status and its enum meanings.
- Closed account: provide an explicit closed flag or documented status/substatus
  combination. The current lookup supplies only a generic numeric status.
- For all fields: confirm missing/unknown semantics, update timestamps and which
  identifier the endpoint expects. Include non-sensitive example responses.

## Email acceptance — prepared, awaiting designated recipient

Production has Postmark inbound/outbound and private attachment storage settings.
This verifies configuration presence only, not delivery. Use a mailbox approved
by Jodi before sending anything:

1. Send formatted text, a harmless file and an inline image from that mailbox to
   the chosen configured support channel. Confirm one customer and one ticket.
2. Reply in the same thread from an approved secondary address on the test
   customer. Confirm it stays with that customer and thread.
3. Send an agent reply containing formatting and a file. Confirm delivery to the
   thread's address and verify the downloaded file at the recipient mailbox.
4. Send a survey to the same designated test customer and verify its link.
5. Verify removed/reassigned address and bounce suppression in isolated fixtures;
   do not intentionally bounce messages against real customer addresses.

## Cache correction — prepared, awaiting Cloudflare access

Public JavaScript, CSS and `sw.js` returned `max-age=14400` on 8 September 2026;
HTML returned `max-age=0`. nginx already emits `public, max-age=0, must-revalidate`.
Inspect Cloudflare rules and apply respect-origin browser TTL only to
`app.respovia.com`. Verify public headers and an ordinary reload. Existing browser
copies may need one hard refresh; a CDN purge cannot evict them remotely.
