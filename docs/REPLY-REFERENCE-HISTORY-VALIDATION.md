# Saved internal reply references

## Behavior

Internal references and review notes are stored as a snapshot in `reply_internal_reviews`, alongside the saved message in the same transaction. They are shown in a collapsed agent-only panel after sending and after reloading a ticket. Source titles/URLs and notes remain available even if the knowledge article changes later. The panel explains that agents may have edited the final reply.

The snapshot is agent-submitted context, not proof that every final sentence is supported. It is not a complete article-version archive. Existing sent messages cannot be backfilled when their local draft references have already been cleared. If delivery fails after saving, the snapshot remains with the saved message.

## Verification

- Frontend build, API typecheck, import audit, 24 route smokes and seven ticket-detail smokes pass.
- Full API suite: 710 tests, zero failures. After the final malformed-URL guard and merge test, the agent-reply suite passed 35 tests with 295 assertions.
- Renderer/storage test passed with 12 assertions, including collapsed saved panels and escaped untrusted content.
- Browser QA used a synthetic ticket and intercepted every API mutation. The composer sent customer text/HTML and a separate `internal_review` field; the saved panel rendered outside the customer body. No email was sent.
- Database tests cover server persistence, reload, cross-workspace rejection, customer-session rejection, portal exclusion, Postmark exclusion, invalid URLs, bounded payloads, merge/unmerge, hard-delete cascade, retention purge and erasure.

## Security review

**Stack:** Hono / TypeScript / PostgreSQL. **Scope:** this diff. **Date:** 2026-09-15.

No unresolved high/critical findings from manual review. Metadata is stored separately from customer messages, queried only in the agent ticket-detail path with workspace predicates, and written in the message transaction. RLS is enabled without a customer-facing policy. Existing public portal and outbound-email projections do not select it. Rendering escapes all text and permits only HTTP(S) links without embedded credentials.

The snapshots follow message deletion and workspace retention. Customer erasure removes them explicitly because messages are redacted rather than deleted. Merging copies the snapshot; unmerge removes only the copied snapshot. Source URLs are never fetched by the persistence code.

Scanners: gitleaks and semgrep are not installed. No dependencies were added; a new dependency audit was not performed. Validation used manual access/data-flow review and real-database regression tests. This is a focused review, not a whole-repository security certification.

## Deployment

Apply migration `20260915140000_reply_internal_reviews.sql` before the API release; the existing Docker startup migration runner does this. Deploy API before frontend. The new table is additive; rolling back application code leaves stored snapshots intact. Production deployment is not part of this PR-preparation task.
