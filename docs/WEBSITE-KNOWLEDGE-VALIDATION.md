# Website knowledge import validation

14 September 2026. Scope: restoration of website sources alongside existing file imports.

## Behavior

- Public HTTPS pages can be imported, refreshed, reviewed and explicitly published.
- Existing website source records and version histories are visible again.
- New sources default to manual checks. Migration 20260914160000 pauses legacy URL schedules; an administrator must enable hourly checks explicitly.
- Scheduled claims recheck opt-in, due time and the existing lease before fetching. Updated text never automatically overwrites a published article.
- File upload, drag-and-drop, replacement, private download and cleanup remain supported.

## Validation

- TypeScript check passed; frontend bundle, bridge collision, import audit and header parity passed.
- All 24 route and 7 ticket-detail smokes passed.
- Full API suite: 687 tests passed, 0 failures, 3300 assertions; PostgreSQL 17.
- Focused fetch/lifecycle suite: 17 tests and 147 assertions, including redirects, private-address rejection, non-HTML/oversized pages, 403 handling, URL deduplication, opt-in scheduling, tenant isolation and migration preservation.
- Frontend source, file-picker, persistence and draft-routing tests passed.
- Fresh apply of all 95 migrations under Node passed. Migration regression preserves saved policy text while pausing old schedules.
- Production Dockerfile builds. A Node container using the real API routes, real HTTPS fetch and Python extractor imported SpaceCasino's terms URL into an isolated test workspace: HTTP 201, one review version, 39,258 characters, unpublished, automatic checks off. Synthetic workspace and user cleaned up.
- This live request used the local Docker host's connection. It does not establish Dokploy egress access or deployed behavior.

# Security Audit: website knowledge restoration

**Stack:** Hono/TypeScript, Node/undici, PostgreSQL, native JavaScript frontend.
**Scope:** Changed routes and source UI, reused fetcher/SSRF checks and scheduler.
**Risk summary:** 0 unresolved findings in this change.

## Findings

No unresolved findings in manual review of the changed paths.

## Detail

Checked workspace ownership on all source reads/mutations, admin authorization, strict URL request schema, parameterized SQL, output escaping, file-only replacement/downloads, public HTTPS-only fetching, redirect validation, DNS checks at connection time, response limits, safe errors, lease ownership and explicit publication. The restored scheduler rechecks opt-in at claim time. Legacy schedule restart was addressed by the migration and covered by a regression test.

## Scanner output

- Dependencies: bun audit --production reports no vulnerabilities.
- SAST: semgrep unavailable; manual review used.
- Secrets: gitleaks unavailable; inspected changed code for secrets, tokens and new logging. No credentials introduced.

## Remediation plan

No outstanding code findings. Verify the deployed API fetch after rollout.

# Design Review: website source form and source management

**Stack:** Native JS and existing Respovia modal/form/button styles.
**Reviewed:** sources.js new website form, source list and review controls.
**Inputs:** Source and behavior tests; no rendered breakpoint screenshots.
**Score:** Not assigned without visual inspection.

## What works

- Website and file actions share the existing source review workflow.
- URL and metadata inputs have labels; hourly opt-in is unchecked by default.
- Form has dialog semantics, initial focus, loading status and duplicate-submit protection.

## Findings

Long source URLs in the review panel needed wrapping; addressed with overflow-wrap:anywhere, matching the source list. No remaining source-level findings.

## Token audit

Existing form-input, form-label and btn classes reused. Action rows retain existing 8px wrapping gaps. No new palette or typography.

## State coverage

Loading, empty, failure and review states exist in source and behavior tests. Rendered contrast, touch-target sizes and responsive geometry remain unverified.

## Remediation plan

Verify the form in the deployed UI during rollout. No redesign included.
