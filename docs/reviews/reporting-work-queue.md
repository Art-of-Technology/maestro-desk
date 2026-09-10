# Design Review: Dashboard periods and Tickets queue

**Stack:** Native JavaScript modules and shared CSS tokens | **Reviewed:** Dashboard and Tickets | **Breakpoints:** 390 / 768 / 1280 / 1920
**Inputs:** Source, original Tickets screenshot, local browser with intercepted API fixtures | **Date:** 2026-09-09
**Score:** 4/5 for changed controls | **Open findings:** no blockers in changed controls; existing expanded sidebar leaves a narrow content column on phones.

## What works

- Tickets prioritizes complete outstanding counts and urgency; pending and GDPR stay visible.
- Headline buttons filter the queue, with textual labels and keyboard focus.
- Dashboard shows exact calendar dates and the browser timezone. Every ticket-related widget describes its period semantics.

## Findings

| ID | Severity | Category | Location | Issue | Fix |
|---|---|---|---|---|---|
| 1 | High, resolved | Data hierarchy | tickets/list.js | Loaded-page counts hid work | Fetch the full outstanding index before publishing counts; page rendered rows separately |
| 2 | High, resolved | Reporting | dashboard/index.js | Today and volume included placeholder calculations | Database aggregates, calendar boundaries, real volume buckets |
| 3 | High, resolved | Responsive controls | pages.css | Summary labels overlapped on narrow content columns | Container-based stacking, wrapping tabs, scrollable page and automatic topbar height |
| 4 | Medium, resolved | Interaction | tickets/list.js | Native button borders affected converted status tabs | Scoped button reset retaining active underline and focus |
| 5 | Low, existing | Density | shell.css | Expanded 200px sidebar leaves little room at 390px | Existing Collapse menu control remains available; no global shell redesign |

## Detail

The live queue has no date cutoff. SLA and escalation overlap, so those counts are not added together. Queue filtering and sorting run only after all bounded API pages load. History fetches resolved/closed records separately.

Dashboard creation/status/priority/agent/customer/AI-tag widgets use tickets created in the selected interval. Reply and rating aggregates use message/submission timestamps. Resolved/closed totals use the latest stored transition timestamp and require the current status to match. They do not claim to reconstruct historical transitions after reopening. The recorded SLA widget labels its stored-state semantics; the Tickets queue evaluates live timing facts using the existing policy/business-hours engine.

## Token audit

| Property | Existing vocabulary | Applied |
|---|---|---|
| Colour | ink, ink2, ink3, off, purple, red, rule | Reused; no palette additions |
| Spacing | Existing 8/12/16/20/24px component and page spacing | Reused, with 28/32px clearance for existing section carets |
| Typography | Existing kpi, tab, btn, filter-select classes | Reused |
| Focus | Theme purple outline | Measured visible solid outline on keyboard traversal |

The queue label measured 5.71:1 against its surface at 1280px. Headline buttons were 82px tall. These are sampled measurements, not a claim of a complete accessibility audit.

## State coverage

| Screen | Loading | Empty | Error | Long content | Mobile |
|---|---|---|---|---|---|
| Dashboard | Status text; no false zeros | Empty widget fixtures | Retry restores data; stale totals hidden | Labels wrap | Screenshots at all four widths; full-page overflow stays within viewport |
| Tickets | Counts wait for the complete index | Empty filters/history supported | Failed index hides incomplete totals; Retry works | Subject truncation preserved | Summary stacks, tabs wrap, page/table scroll |

Screenshots are local test artifacts in `C:/Users/Jodi/AppData/Local/Temp/respovia-reporting-review/`.

## Remediation plan

Changed-control findings are resolved. A separate shell-wide mobile navigation pass could reduce phone scrolling.

## Code review and validation

Self-review covered workspace/session boundaries, late responses, pagination, date boundaries, nullable SQL aggregates, saved search compatibility, history filters, and urgency-count overlap. Found and fixed stale-workspace response handling, the History view chip, invalid calendar input, nullable recorded SLA values, and a SQL alias issue.

- Full API suite: 617 passing tests against an isolated PostgreSQL 17 database.
- After final API date validation: 27 focused database/isolation tests passing.
- Six calendar tests, including leap years and UK DST days of 23/25 hours.
- Build, API typecheck, bridge collision and import audit passing.
- All 24 route smokes and seven ticket detail smokes passing.
- Native-browser fixture test: 205 outstanding tickets, late-page breach first, stable counts after Show more, pending included, overlapping urgency counts, history, every period preset, custom validation, error/retry, and discarded old-workspace response.

The queue index is transferred in 200-row pages and only 50 matching rows render initially. Browser memory still grows with the outstanding queue (and history when opened); there is no silent row cap. Existing business-hours configuration semantics are unchanged.

## Octopus follow-up: 2026-09-10

Addressed the two inline findings and the missing-row concern in the summary:

- Empty sync responses retain queue and Dashboard caches and DOM. Local SLA threshold changes repaint the queue without an index request. Calendar presets advance at midnight without needing a ticket delta.
- The sidebar starts or joins a shared queue load from any page, then paints the complete count without re-rendering that page. Loading/error states never masquerade as a partial total. Completion callbacks ignore discarded workspace loads.
- Every index page is validated. Ticket mapping and pruning run against copies before shared state is committed; mapping failures leave existing ticket data and object identities untouched.

Validation: build, API typecheck, import/bridge audits, six calendar tests, all 24 route and seven detail smokes passed. The native-browser regression additionally passed empty-poll request/DOM checks, local SLA transitions, calendar rollover, Dashboard-only sidebar loading, shared pending requests, malformed/missing rows after a valid first page, and late workspace response isolation. Self-review verified the optional mapping target leaves ordinary bootstrap/sync callers unchanged.
