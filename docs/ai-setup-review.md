# Security Audit: AI setup diff

**Stack:** Hono/TypeScript/Node, Postgres, native browser ES modules
**Scope:** AI relay, context loader, client and settings changes | **Date:** 2026-09-09
**Risk summary:** No unresolved exploitable findings in the changed paths.

## Findings

| ID | Severity | Category | Location | Issue | Fix |
|---|---|---|---|---|---|
| S1 | High, resolved | Secrets | `web/js/ai/client.js` | Browser held the provider key | Server-only key; remove legacy storage and direct provider CSP allowance |
| S2 | High, resolved | Privacy | `web/js/ai/page.js` | Chat bypassed the player-data setting | Server-built workspace context gates account attributes |
| S3 | High, resolved | Isolation | `web/js/ai/page.js` | Unscoped chat history could cross user/workspace boundaries | Scope session history and reject stale responses |
| S4 | Medium, resolved | Spending | `api/src/routes/ai.ts` | Concurrent calls could share the same credit | Atomic reservation, strict schema, output cap and database rate limiter |

## Detail

The relay reuses `requireAuth`, which verifies membership before querying the
workspace. Context queries filter workspace IDs at the database, including the
roles join. Client-supplied workspace IDs, unknown fields, unpriced models,
invalid roles and excess input are rejected. Tests verify that foreign-workspace
requests never invoke the provider. The relay accepts text only and exposes no
tools, URL fetching or code execution. Error messages do not echo provider keys,
provider exception bodies or prompts. Credit and usage records use server-derived
workspace/user identities. Privacy updates retain the existing admin-only route.

## Scanner output

- `bun audit --production`: 12 existing advisories (1 high, 10 moderate, 1 low)
  in the locked Hono/Undici versions; no dependencies changed. The high advisory
  concerns Undici caching directives; the changed AI paths use the Anthropic SDK
  and do not install a caching interceptor. Dependency updates require a
  separate, reviewed change. This is not a claim that the whole repository is
  free of dependency risk.
- Semgrep and gitleaks are not installed. Manual review of the changed files
  found no embedded secrets, command execution, raw SQL interpolation or
  provider credentials in the browser. No repository-wide secret scan claimed.
- Database tests cover unauthenticated and foreign-workspace access, privacy
  opt-in, input/body limits, failure refunds, concurrent reservations and limits.

## Remediation plan

The AI findings above are resolved. Track the baseline dependency advisories
separately. See `ai-setup.md` for reservation recovery and timeout limitations.

# Design Review: AI settings

**Stack:** Native ES modules/CSS | **Reviewed:** AI settings form
**Breakpoints:** 390 / 768 / 1280 | **Date:** 2026-09-09
**Inputs:** Source, Playwright interaction checks and screenshots
**Score:** 4/5 | **Unresolved changed-form findings:** 0

## What works

- Model selection, connection checking, credit status and privacy are grouped
  using existing settings styles and tokens.
- Connection and save results have live regions. Provider errors provide a
  next step, and failed drafting preserves the user's text.

## Findings

| ID | Severity | Category | Location | Issue | Fix |
|---|---|---|---|---|---|
| D1 | High, resolved | Interaction | `web/js/settings/index.js` | New actions initially used the input registry | Register click/change events correctly; browser regression coverage |
| D2 | High, resolved | Layout | `web/styles/pages.css` | Fixed settings columns clipped the model control at 390px | Stack the AI settings columns below 900px |
| D3 | High, resolved | Keyboard/touch | `web/styles/pages.css` | Existing compact toggle lacked a focus ring and touch area | Scoped visible keyboard ring and 44px hit area |

## Detail

The new model select has an associated label. The checkbox has an accessible
name, works with Space and shows an ink focus ring under keyboard navigation.
All three checked widths fit the model control; connection buttons measure
44px high. The existing expanded application sidebar leaves a narrow content
column on phones; its existing collapse control provides more room. This review
does not certify the accessibility of the rest of the application.

## Token audit

Existing ink, surface, rule and radius tokens retained. Form text uses existing
11/12/13px settings density; new action minimums are 44px. No palette changes,
new dependencies or global sidebar redesign.

## State coverage

Loading status, configured/failed connection, model changes, credit error,
admin/non-admin privacy control, save confirmation and mobile form checked.
Screenshots retained outside the repository in the local Codex artifact folder.
No axe scan was run; keyboard and bounding-box checks were manual/Playwright.

## Remediation plan

Changed-form findings resolved and browser checks passed. Broader application
mobile navigation and accessibility remain outside this change.
