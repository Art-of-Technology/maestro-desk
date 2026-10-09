# Statistic view preference sync

Each supported Dashboard and Insights selector saves privately for the signed-in
user and workspace. The existing `user_preferences` table gains a `stat_views`
JSON object. `/api/v1/me/stat-views` reads that object and atomically updates one
validated statistic at a time. Other profile/layout preferences are preserved.

The shared selector loads preferences when first rendered in a session/workspace.
Server choices take precedence over old browser copies. Legacy choices import
only into missing keys, with that condition enforced atomically in PostgreSQL.
Explicit unsynced edits persist as one browser record containing both value and
receipt, and retry on reconnect, re-render, refresh or the Retry button. Demo
preferences remain local. No dependencies or realtime infrastructure were added.

## Validation

- PostgreSQL 17: migration applied successfully; Node/tsx migration rerun was a
  no-op. API typecheck passed.
- Five API/schema tests passed, including real authentication, membership
  rejection, separate user/workspace storage, concurrent updates, import races,
  field/format validation and preservation of unrelated preferences.
- Nine sync tests passed: empty browser restoration, logout/login, legacy import,
  concurrent import, rapid changes, delayed hydration, stale account/workspace
  responses, offline refresh/reconnect, blocked storage, demo behavior and a
  failed-save retry changing to a newer selection.
- Four existing statistic format tests, five Insights reporting tests and four
  guide tests passed. CI runs the new sync test file separately to isolate mocks.
- All 58 frontend Bun test command groups from CI passed locally. The first PR
  CI run exposed missing preference API exports in two report-test mocks; both
  fixtures now provide the new API contract while preserving report assertions.
- Frontend build, bridge/import checks, 24 routes and seven ticket details passed.
- Chrome fixture used the actual native modules and controls with an in-memory
  HTTP API. `localhost` and `127.0.0.1` supplied separate browser storage origins;
  a saved format restored across them. Also checked account/workspace isolation,
  sign-out/sign-in, offline failure, Retry, refresh recovery and reconnect.
- Mobile check at 390px: no horizontal overflow; selector and Retry targets are
  at least 44px. Existing labels, focus styles, accessible tables and live save
  status remain in use. Browser error/warning log was empty.

## Focused review

Code/security review: no unresolved findings in this change. Requests use the
existing authenticated middleware; both database keys come from its context.
Accepted IDs/formats are finite, unknown fields are rejected, SQL is parameterized,
and reads/writes return `Cache-Control: no-store`. The browser never stores a token
in preference keys. Async results and queued requests check session identity,
workspace and credential before updating state or issuing another request.

Resolved during review: retrying a failed save could temporarily show the old
selection; a regression test now covers the fix. The new Retry button initially
missed the mobile touch target; its scoped mobile rule now sets 44px minimum.
An atomic browser record avoids separating the cached value from its pending
receipt when storage fills. Design review of the changed states: 4/5, no blocking
findings. Customer-facing save messages and guide copy were reviewed for clarity.

`bun audit --audit-level=high` reported no vulnerabilities. Semgrep and Gitleaks
were unavailable; no whole-repository SAST or secret-scan claim is made. This was
a focused review of the diff, not a penetration test or production user-data test.

## Limits and rollout

Deploy the additive migration/API and frontend through the normal Dokploy
workflows. During a web-before-API rollout, the selector remains usable locally
and reports sync failure until Retry, reconnect or refresh succeeds.

Other devices load choices after refresh/login or first opening a statistic in
that session/workspace; changes are not pushed live. For the same statistic the
last successful server update wins. Different statistics cannot overwrite each
other. With both network and browser storage unavailable, choices survive only
in the current page; the UI explicitly asks the user to keep it open and retry.
