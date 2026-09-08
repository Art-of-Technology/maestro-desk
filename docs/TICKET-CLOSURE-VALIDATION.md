# Ticket closure validation

Agents can choose **More → Close without resolution**, or choose the same action in the bulk status menu. Spam, Abuse, Duplicate, and Other are supported reasons. The optional note is internal. Closed tickets remain searchable and can be reopened explicitly.

## Verification

- PostgreSQL 17: all 90 migrations applied to a fresh disposable database using the production Node/tsx runner; a second run skipped all applied migrations.
- Backend: 602 tests passed across 70 files. After the final expired-survey-claim adjustment, all 25 agent reply/closure tests passed again.
- Frontend: build, bridge collision check, import audit, 24 route smokes, seven ticket detail smokes, and 25 URL/navigation tests passed.
- Isolated Chrome: single closure, required reason, cancellation, escaped note text, reopening, metric exclusions, bulk partial failure and retry, and the Closed tab passed. No page errors. The repeatable check is `scripts/ticket-closure-browser-check.mjs`.
- Surveys and AI email delivery were mocked in tests. Tests used a disposable local database; no production migration or deployment was performed.

## Code review

Self-review covered workspace isolation, concurrent closure/survey requests, stale status writes, duplicate requests, incoming replies, internal-note visibility, synchronization, and reporting. Findings resolved:

- Survey eligibility is checked when the database send claim is acquired. Closure refuses an active send claim and clears expired claims using the dispatcher's ten-minute expiry.
- The closure row and its system message are committed together. Repeated closure preserves the first reason, timestamp, and audit message.
- Status-only API writes cannot close tickets, and a closed ticket must be reopened before it can be resolved. A stale portal reply cannot overwrite a concurrent closure.
- Incoming replies on closed tickets are retained without AI retriage or offline-agent notification. The automatic reply dispatcher also checks closed status.
- Closure notes participate in the existing data export and erasure paths; system messages stay out of the customer portal preview.
- Failed bulk saves preserve local status and selection. Retry sends only the failed tickets.

# Design Review: Ticket closure

**Stack:** native JavaScript/CSS | **Reviewed:** closure dialog, ticket details, bulk action | **Breakpoints:** 390 / 768 / 1280
**Inputs:** source and isolated Chrome screenshots | **Date:** 2026-09-08
**Score:** 4/5, self-review | **Open findings:** 0 blocking findings in the closure flow

## What works

- A required reason and optional internal note make the outcome explicit.
- Closed status and its reason use text, not color alone.
- Per-ticket errors remain visible and retryable after a partial bulk failure.

## Findings

| ID | Severity | Location | Issue | Applied fix |
|---|---|---|---|---|
| 1 | High | `web/js/tickets/detail.js` | Long action crowded the mobile toolbar | Put closure in the existing More menu |
| 2 | High | `web/js/tickets/detail.js` | Reason was hidden in the collapsed CSAT section | Place closure details above that section |
| 3 | Medium | `web/js/tickets/closure.js` | Corrected reason retained its error | Clear the error on selection change |
| 4 | High | `web/styles/components.css` | Small-screen modal actions measured 32px tall | Set closure controls to at least 44px below 769px |

## Detail

The dialog now has an accessible name, associated labels, initial focus, a Tab loop, Escape dismissal, and an announced error region. The status dropdown resets when the action opens so cancellation cannot falsely display Closed.

## Token audit

| Property | Existing vocabulary used | Closure values |
|---|---|---|
| Color | `--ink2`, `--off2`, `--red` | No new color tokens |
| Spacing | 8px and 16px | Note separation and introductory paragraph |
| Type | 12px and 13px | Secondary text and error text |
| Touch controls | 44px minimum | Select and action buttons at small breakpoints |

## State coverage

| Loading | Empty reason | Error | Long content | Mobile |
|---|---|---|---|---|
| Disabled confirm with Closing label | Rejected with focus on reason | Per-ticket failure and retry verified | Notes wrap and are capped at 4,000 characters | Dialog widths 351px at 390; 520px at 768/1280; no horizontal overflow |

## Remediation plan

All findings above are resolved. The score covers this flow, not an accessibility audit of the entire application.
