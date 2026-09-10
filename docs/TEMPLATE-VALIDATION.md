# Rich response template validation — 10 September 2026

Saved responses now use the existing Quill editor. An additive `body_html`
column stores sanitized formatting and raster images; `body` stays plain text
for older templates and clients. A body-only edit clears stale HTML. Both the
picker and macro reply steps preserve formatting and append to the draft.
All four supported variables resolve in text nodes, never HTML attributes.

## Validation

- API typecheck and 624 tests passed on local PostgreSQL 17, with legacy KYC
  absent and the additive template column applied. New tests exercise HTML
  sanitization, image retention, plain fallback, CRUD, admin authorization and
  workspace isolation. The old plain body stays readable after the migration.
- Frontend build, bridge/import/header checks, 24 route smokes and seven ticket
  detail smokes passed.
- `scripts/templates-browser-check.mjs` passed against native browser modules:
  first template in an empty authenticated workspace reaches the API; save/edit
  preserves formatting and an embedded image; variable insertion works; template
  and macro insertion preserve the draft; malicious variable values remain text;
  a failed editor download allows editing and saving an old plain template.
- Template modal inspected at 390, 768, 1280 and 1920 pixels. No horizontal
  overflow in the modal. Name/category labels and the rich text body have
  accessible names. Existing modal styling and toolbar are reused.
- Manual code review covered parameterized workspace predicates, admin writes,
  HTML scheme/tag/attribute restrictions, variable substitution, stale editor
  references, first-template persistence and save failure behavior.

## Release and acceptance limits

Deploy API before web so the additive migration and API field exist first.
Existing templates require no conversion. A rollback retains the extra column;
do not drop it or roll back before the KYC-compatible release described in
KYC-RETIREMENT.md. Template HTML is capped at one million characters; the API
rejects larger bodies. Embedded images use the existing outbound email pipeline.

The browser fixture intercepts API traffic, and API tests use a disposable local
database. Neither proves delivery to a real mailbox. Incoming rich email,
attachment receipt/download, secondary-address routing and a survey still need
the designated test recipient and live acceptance evidence.
