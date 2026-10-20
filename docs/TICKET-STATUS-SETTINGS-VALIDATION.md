# Ticket status settings validation

Validated 2026-10-20 against PostgreSQL 17, the Node migration runner, native browser modules and Bun 1.3.13.

## Scope and behavior

Brand admins manage named choices under Configuration → Ticket statuses. Each choice has an immutable canonical category and a survey rule. Agents can select choices from ticket detail, bulk actions, macros and send actions, and filter tickets by custom choices. Closed choices use the existing required-reason flow. Ticket templates retain their existing open-ticket default.

`tickets.status_key` remains canonical. `status_option_key` records the selected choice; `status_survey_enabled` snapshots its survey rule. Settings edits do not change prior selections. Retirement hides choices without deleting ticket history and refuses choices referenced by active macros. Merge/unmerge restores the original choice and policy, including retired choices. Customer replies reopen through the existing canonical workflow.

## Validation evidence

- All 135 migrations applied to fresh PostgreSQL 17 under Node/tsx; a Bun rerun was a no-op. A separate upgrade fixture applied the migration over existing canonical and legacy custom statuses and preserved choice IDs, terminal categories and survey rules.
- API: 975 passing tests across the Linux suite and the separately rerun email-export/download suites. The production image omits the `postal-mime` development dependency, so those two suites were rerun with the installed package mounted. Windows runs cannot validate POSIX audit evidence flushing or the container PDF renderer; those checks ran in Linux.
- Nine feature tests, 89 assertions: admin/member/brand boundaries, closure reasons, automatic/manual survey suppression, settings snapshots, retirement, macro dependencies, concurrent retirement/selection, saved filters, creation defaults, resolution timestamps and merge restoration.
- Frontend test files run separately to isolate Bun mocks. Updated source-extraction fixtures include the new status dependency. Browser fixtures cover create/retire, retained retired selections, no-survey messaging, closure cancellation, custom send actions, loading errors, admin guards, focus trapping and Escape.
- Frontend build, typecheck, import audit, bridge collision check, header synchronization, all 25 routes and all seven demo ticket details passed.
- No real customer email was sent. Mail delivery tests use synthetic providers; browser acceptance intercepts local API calls.

## Code and security review

Reviewed routes, SQL triggers, survey claims, audit sanitization, ticket mapping, agent reports, complaint counts, macros and callers before the PR.

| Finding | Resolution |
|---|---|
| Custom option IDs would break resolution-credit audit queries | Preserve canonical before/after fields; record option IDs separately |
| Audit minimization discarded new option/policy facts | Extend the allowlist for controlled IDs and booleans; names remain in erasable activity, not permanent audit metadata |
| Retiring a choice could race a macro save | Hold scoped status share locks through macro validation and write; retirement checks references after its exclusive lock |
| An already-started survey could race a no-survey change | Atomic mailer claims check the snapshot; status changes return 409 while a claim is active |
| Merge/unmerge could lose a custom selection | Save and restore its choice and survey snapshot, including retirement |
| Delayed metadata or ticket responses could affect another session | Scope caches and status edits to workspace and token |

No unresolved high or critical findings in this scope. New routes use the existing verified Maestro identity and server-side brand-admin guard. SQL is parameterized and workspace-scoped. This is a feature review, not a new whole-repository penetration test.

# Design Review: Ticket status settings

**Stack:** Vanilla JS, existing CSS tokens and modal | **Reviewed:** settings and status selection | **Breakpoints:** 390 / 768 / 1280 / 1920
**Inputs:** source and local Chrome screenshots | **Date:** 2026-10-20
**Score:** 4/5 | **Findings:** Critical 0, High 0, Medium 0, Low 1 remaining

## What works

- Existing typography, status tags and a single primary Add status action.
- Explicit category/survey labels and readable availability text.
- Dialog names, labels, keyboard trap, Escape and restored trigger focus.

## Findings

| ID | Severity | Category | Location | Issue | Fix |
|---|---|---|---|---|---|
| 1 | High, resolved | Responsive | `web/styles/pages.css` | Fixed-height header and flex shrink clipped settings on phones | Allow the header to wrap and the page to scroll |
| 2 | Critical, resolved | Keyboard | `web/js/settings/ticket-statuses.js` | Shared modal lacked dialog semantics and keyboard close | Add scoped dialog semantics, a close button, focus trap and Escape |
| 3 | High, resolved | Touch | `web/styles/pages.css` | Small default buttons at phone width | Minimum 44px controls on narrow/coarse-pointer screens |
| 4 | Low | Table density | settings table | Phone users scroll horizontally to reach policy and Edit | Intentional labelled, keyboard-focusable scroll region; no card redesign |

## Detail

Resolved findings use scoped existing CSS tokens and modal controls. The remaining table tradeoff preserves all columns and actions in the scroll region. Keyboard users can focus that region and scroll it.

## Token audit

| Property | Declared system | Values used | Off-scale hits |
|---|---|---|---|
| Color | Existing ink/purple/surface tokens | Existing tokens only | None |
| Spacing | Existing dense CRM styles | 8, 12, 16, 32px | None |
| Type and radius | House components | House classes | None |

Measured text contrast: notes 9.04:1, table headings 6.28:1, table body 10.11:1, primary button 7.10:1. Scoped focus rings use the existing purple token. Phone controls meet 44px minimum height.

## State coverage

| Screen | Loading/error | Existing/retired | Long content | Mobile | Keyboard |
|---|---|---|---|---|---|
| Settings | Covered | Covered | 80-character input | Rendered | Covered |
| Agent selector | Disabled on metadata failure | Retired selection retained | Escaping unit test | Existing ticket layout | Native select |

Built-in choices make a truly empty production table unavailable. No new dark-mode system was introduced.

## Remediation plan

No remaining blocking fixes. Consider a mobile card layout only if agents or admins report difficulty using the table.

## Deployment and limits

Apply the additive migration before serving the updated API/frontend. Existing canonical API writers remain compatible. Reload already-open agent sessions to see newly configured choices. Historical surveys cannot be recalled. Combined send-and-status remains two operations: delivery can succeed if a concurrent settings change prevents the later status save; agents should check the final status, as the existing guide explains.
