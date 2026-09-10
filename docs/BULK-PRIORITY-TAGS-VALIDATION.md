# Persistent bulk priority and tag changes

Bulk priority changes now PATCH each selected ticket; bulk tags POST to the
existing idempotent tag endpoint. Local priority/SLA and tag state change only
after the server confirms each save. Failed tickets stay selected and can be
retried without repeating successful requests. Duplicate submissions are blocked.

The shared sequential save helper also backs bulk assignment, retaining its
response-validation and context-cancellation contract. Dismissing the dialog or
switching session/workspace stops remaining requests; an in-flight save may still
complete in its original workspace. The full work index refreshes after a batch.

Tags are normalised and limited to 64 characters. Existing tags are preserved;
repeated POSTs cannot duplicate the ticket/tag relation. Tag library counts are
read from the server rather than incremented optimistically, including after a
partial save. Failed count refreshes show a warning instead of inventing counts.

## Validation — 10 September 2026

- API typecheck and 645 API tests pass on isolated local Postgres.
- 50 frontend tests pass, including seven new priority/tag tests and all five
  existing bulk-assignment tests after the shared-helper extraction.
- Build, import/collision/header guards, 24 route smokes and seven detail smokes
  pass.
- `scripts/bulk-edit-browser-check.mjs`: 19 native-module checks pass, covering
  both actions, held requests, duplicate clicks, confirmation before mutation,
  partial failures, retry-only-failed behaviour, existing tags, accurate counts,
  full reload persistence and cancellation. APIs are intercepted local fixtures.
- Bulk-assignment browser regression: all 16 existing checks pass, including
  duplicate agent names, inactive agents and workspace changes during a request.
- Manual code review covered API response contracts, UUID scoping, tag
  idempotence, count refresh failure/stale responses, modal lifetime, selection
  snapshots, output escaping and preservation of assignment behaviour.
- UI review confirmed labelled native inputs, saving/error states, and a tag
  dialog that fits a 390px viewport with validation text visible.
- Credential scan: no strong credential patterns or tracked non-example env
  files. No database migration, dependency or environment changes.

CI, Octopus review and production acceptance evidence are attached to the PR.
