# Knowledge review and game links

## Behavior

Articles retain their API status when loaded or created. The library and related
cards show Awaiting review, Published or Archived. Status filters include counts
within the current category and search. New articles save as drafts and open for
review; an explicit Publish article action makes them available to AI. Existing
published-article edits retain their current behavior, with an explanatory note.

A body containing one HTTP(S) URL renders as a compact link with its destination
host. The stored body remains the full URL for AI retrieval. Other bodies retain
the existing markdown renderer. No database or AI retrieval changes are required.

## Validation

- Build, bridge collision check and import-completeness audit passed.
- All 24 route smokes and seven ticket detail smokes passed.
- Knowledge persistence/review tests: 24 assertions; article-state/link tests:
  13 assertions. Both passed.
- Existing draft-routing, source management and file-picker tests passed.
- API typecheck passed; 295 hermetic tests passed, 495 DB-dependent tests skipped
  locally. CI runs the database-backed tests.
- Header synchronization and diff whitespace checks passed.
- Browser checks used local frontend modules with API writes intercepted in a
  separate preview tab. Tested review filtering, saving a new draft, an explicit
  publish transition, and exact game link destinations. No production article
  was published during these checks.
- Code review checked status mapping, escaped links, unknown-state fallback,
  workspace changes during a request, duplicate publish submissions and failed
  saves. Publishing updates only the returned status/date in client state so
  author and other metadata are retained.

## Data cleanup

The approved one-off Space Casino cleanup updated 1,589 imported game articles:
title = locale plus game name; category = Games plus locale; body = original
game URL. Game names came from the captured page heading, removing only the
observed Play/Jugar/Jogar/Pelaa prefix. No translated names were invented.

A fresh backup was saved before writes, and each candidate was compared against
the live article before the batch began. Post-write verification found zero
mismatches and zero changes to other article content or statuses. All 2,237
imported articles remained drafts; the two existing published articles remained
unchanged. Backup and per-article results are stored in Jodi's local Documents
folder, outside the repository.

# Design Review: knowledge review controls

**Stack:** native JavaScript/CSS | **Reviewed:** KB list and article
**Breakpoints:** 390 / 768 / 1280 | **Inputs:** source and browser screenshots
**Date:** 2026-09-15 | **Score:** 4/5 for the changed controls

## What works

- Existing semantic color and spacing tokens fit the new status badges.
- Review filters use native buttons with pressed state and visible counts.
- The article has one primary publishing action and an explicit AI availability note.

## Findings

| ID | Severity | Location | Issue | Fix |
|---|---|---|---|---|
| 1 | High, resolved | core/bootstrap.js; kb/index.js | Draft status was discarded and invisible | Retain status; show badges and filters |
| 2 | High, resolved | kb/index.js | Existing drafts had no publish action | Explicit publish flow with failure and session guards |
| 3 | Medium, resolved | kb/index.js | Link-only bodies displayed as plain text | Compact, escaped HTTP(S) anchor |
| 4 | Existing limitation | application shell at 390px | Expanded global sidebar leaves little content width | Separate shell responsiveness follow-up |

## Detail

The Awaiting review badge measured 5.88:1 text contrast on its banner. The new
publish action is 44px high. Filters and the standalone link have explicit focus
outlines. Desktop and tablet layouts were inspected. At phone width, new controls
wrap, but the existing expanded application sidebar still consumes 200px; this
change does not redesign the application shell.

## Token audit

Uses existing amber/green/ink/off/blue colors, radius tokens and 4/8/12/16px spacing.
No new colors or global spacing scales were introduced.

## State coverage

Verified draft/published/archived, filtered/empty result, long URL, new draft,
failed publish, duplicate submit and session change. Full-app accessibility was
outside this focused review.

## Remediation plan

The requested controls and link rendering are resolved. Phone-width application
shell behavior is a separate improvement.
