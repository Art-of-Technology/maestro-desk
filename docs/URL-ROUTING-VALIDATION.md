# URL routing validation

Routes use `#/w/<workspace UUID>/tickets/<ticket UUID>` and
`#/w/<workspace UUID>/customers/<customer UUID>`. Other registered pages have
the same workspace prefix without a record ID; the platform page is `#/god`.
Demo routes use display IDs without a workspace prefix. Search queries, filters,
modal state and unsaved forms are not encoded in links.

Workspace changes through browser history reload through authenticated bootstrap.
Membership or the existing platform-admin brand endpoint is checked before
workspace data loads. The URL cannot grant access. No API or schema changes.

## Checks

- 14 automated URL parsing/navigation tests: valid pages, malformed routes,
  auth-fragment exclusion, UUID scoping, history deduplication, direct ticket
  fetch, late-response cancellation, inaccessible records, OAuth return state
  and draft separation across workspaces/users.
- Frontend build, bridge/import/header checks, 24 route and 7 ticket-detail smokes.
- API TypeScript check.
- Native-module Chrome tests against a local static host with intercepted API
  fixtures: ticket outside the initial list; ticket/profile refresh; email login
  to a pending link; platform-admin link; workspace switch and Back; repeated
  renders; malformed/missing records; access denial; delayed response after
  navigation; OAuth callback restores destination and removes token/return state.
- Manual review of route parsing, workspace selection, token handling and async
  cancellation. No dependencies added. Dedicated SAST/secret scanners unavailable.

Browser tests used synthetic users and intercepted requests, including presence
and profile refresh. They did not send real emails or create production tickets.
External Maestro authentication itself was not exercised by these local tests.

Drafts now include workspace and signed-in user in their storage keys. Older
unscoped drafts remain in localStorage but are not automatically loaded: their
workspace/user ownership cannot be established safely from a ticket number.
