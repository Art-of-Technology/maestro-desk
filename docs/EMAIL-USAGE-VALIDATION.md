# Email usage monitor validation

Date: 2026-09-14. Scope: the email usage monitor change only.

## Automated checks

- API TypeScript check passed.
- Full API suite: 692 passed, zero failures, including nine monitor tests.
- Monitor tests cover Eastern renewal boundaries, short months, thresholds,
  account enumeration, incomplete provider results, stale data, admin-only
  access, cron authentication, Slack retry, deduplication and allowance changes.
- All migrations applied to an isolated local PostgreSQL 17 database.
- Frontend build, bridge collision, import completeness and header sync passed.
- Rebuilt route smoke: 24 routes passed. Rebuilt ticket detail smoke: seven passed.
- Read-only live provider collection succeeded. No live Slack warning was sent.

# Security Audit: email usage monitor

**Stack:** TypeScript/Hono/PostgreSQL | **Scope:** monitor diff | **Date:** 2026-09-14
**Risk summary:** Critical 0, high 0, medium 0, low 0 in the reviewed diff.

## Findings

No unresolved security findings in the scoped manual review.

## Detail

The new status endpoint sits behind existing platform-admin middleware; tests
verify anonymous and ordinary-user rejection. The cron endpoint uses the
existing bearer-secret middleware. Provider requests target a fixed host with
redirects disabled and time limits. SQL is parameterized. Only aggregates enter
the snapshot; provider tokens, addresses and response bodies are not returned
or logged. UI strings are encoded and numeric values coerced. Slack destinations
are operator-controlled environment settings, not request inputs.

## Scanner output

- Dependencies: `bun audit` reported no vulnerabilities; no dependencies added.
- SAST: Semgrep unavailable; manual review completed.
- Secrets: Gitleaks unavailable; changed files manually checked for credentials.
- This scoped review is not an application-wide security certification.

## Remediation plan

No open security remediation in this diff. Confirm the alert destination before
enabling outbound notifications.

# Design Review: email usage panel

**Stack:** native JavaScript and existing CSS tokens | **Reviewed:** status card
**Inputs:** source and isolated browser preview using actual renderer/CSS | **Date:** 2026-09-14
**Score:** 4/5, scoped review | **Findings:** two interaction issues resolved

## What works

- Usage total and plain-text status are prominent; meaning does not rely on colour.
- Failed and stale states explicitly say current usage is unknown.
- Postmark billing link and estimate caveat explain the count's limits.

## Findings

| ID | Severity | Category | Location | Issue | Fix |
|----|----------|----------|----------|-------|-----|
| 1 | High | Form state | web/js/god/index.js:refreshEmailUsage | Timer could replace unsaved brand form | Replace only the status card |
| 2 | Medium | Keyboard | web/js/god/index.js:refreshEmailUsage | Card replacement could remove the focused link | Defer replacement while card contains focus |

## Detail

Both issues are resolved in the final change. A successful fetch updates cached
state; the timer replaces only the card when it does not contain keyboard focus.
The surrounding form is untouched.

## Token audit

Existing card radius/background and ink colours retained. Spacing uses 12/16px;
metadata uses the existing 12px type size. Metadata foreground #413d54 on card
background #eff2e5 exceeds 4.5:1. Browser-native anchor focus remains available.

## State coverage

Warning and stale cards visually checked at 390px and desktop-width containers.
Setup and pending states inspected in the preview and accessibility tree.
All status branches reviewed in source. These were isolated component previews,
not a complete responsive application or screen-reader audit.

## Remediation plan

No blocking UI findings remain. Production smoke and alert destination setup
remain deployment work. Usage is an estimate; Postmark billing is authoritative.
