# Space Casino import exclusions

Brazil and Peru are no longer supported. Their 335 existing articles were removed from the live knowledge base separately, leaving 1,902 articles. This change prevents recognised imports from reintroducing those jurisdictions.

## Rules

The rule applies only to Space Casino workspace `69a587ed-4487-427a-a06c-610d98d83149`, the same stable identity used by the existing Maestro connection migration. Other workspaces are unaffected.

Recognised markers include Brazil/Brasil/BR/BRA, Peru/Perú/PE/PER, `pt-br` and `es-pe`, locale-prefixed titles, market categories, Space Casino URL paths, and import provenance headers. Generic Spanish, Portuguese and supported-market content remain allowed. Ordinary country mentions and footer links in supported-market documents are not grounds for rejection.

Checks run at source creation, every website redirect before fetching, refresh/reprocessing, file replacement, version storage, source publication, and direct article creation/editing. This covers bulk import clients using the article API. Blocked scheduled sources have automatic refresh disabled and retain a readable error. A user cannot turn automatic refresh back on while the source metadata remains excluded. Existing versions cannot bypass the publication check.

The error shown through existing import screens is: “Brazil and Peru are no longer supported by Space Casino. Choose a supported jurisdiction.” No new UI or database migration is needed.

## Validation

- Full API suite on isolated PostgreSQL 17: 714 passed, zero failures, 3,581 assertions.
- Final focused URL/policy tests after adding hostname normalization: seven passed, 50 assertions.
- Database tests exercise source rejection before fetch, direct/bulk article rejection, edit rejection without modification, supported markets and unrelated workspaces, scheduled-source disabling, and stored-version publication rejection.
- API typecheck, frontend bundle, import audit, 24 route smokes and seven ticket-detail smokes passed.
- Code review checked exact workspace scope, safe error handling, unchanged SSRF protections, redirect checks, and lease ownership during failure cleanup. No unresolved findings.
- No production imports or publications were performed while testing. This PR is not deployed.

## Limits

The policy uses explicit metadata and provenance, not semantic classification of arbitrary unlabeled documents. Direct database writes outside the application APIs are outside this guard. The policy is intentionally specific to the existing Space Casino workspace; expanding it to additional brands or a configurable market list is separate work.
