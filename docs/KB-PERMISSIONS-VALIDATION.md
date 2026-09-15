# Knowledge article permissions

## Change

Article creation, editing (including publishing and archiving), and deletion now use the existing `requireWorkspaceAdmin` helper before parsing or modifying article data. The helper reads active workspace roles and platform-admin status from the database on every request. Reading, view counts and helpfulness votes retain member access.

Both individual and bulk publishing use the same protected PATCH route. No article content, status defaults, imports, frontend controls or database schema changed.

## Focused security review

Stack: Hono, TypeScript, Better Auth, PostgreSQL. Scope: article management routes and their existing authentication/authorization helpers.

The identified access-control issue was member-level creation and modification of AI-visible knowledge, including publishing through the default create status or editing already-published content. All three management routes now enforce the established admin rule. Parameterized workspace predicates remain in place for updates and deletes. Platform-admin access retains its intentional cross-workspace behavior; article operations still use the explicitly selected workspace.

Manual review found no unresolved issue in this change. Gitleaks and Semgrep were unavailable locally; no dependencies or secrets were added. This was a focused access-control review, not a repository-wide audit.

## Tests

The new database-backed API tests use real sessions, workspace memberships and the unmocked authorization helper. They verify:

- Member requests to create drafts or published articles, omit status, publish, archive, edit content and delete return 403 without changing article rows.
- Workspace admins and platform admins can create, publish batches through repeated PATCH requests, edit, archive and delete.
- Role downgrade between publishing requests, inactive membership and revoked platform-admin access block subsequent requests.
- An admin of two workspaces cannot mutate an article using the wrong workspace header.
- Members can still read, record views and vote.

Local verification uses an isolated disposable PostgreSQL 17 container with all 96 migrations applied. No production records are used or changed. Build, API typecheck and frontend import/collision checks pass. The targeted suite passes five tests with 58 assertions.

The complete local API suite also passes: 701 tests, zero failures, 3,481 assertions.
