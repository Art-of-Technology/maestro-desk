# Maestro identity validation release checks

This change keeps Better Auth, existing identities, sessions and client credentials.
It does not change Maestro registration, roles, company approval or membership policy.

## What the code enforces

- Signed RS256/EdDSA ID tokens validated with Better Auth's existing JWKS verifier.
- Exact configured issuer, client audience, required expiry/issued-at/subject/email
  types, and no untrusted extra audiences or mismatched authorized party.
- Only boolean `true` counts as verified email. New implicit and explicit links
  require verified local and remote identities. Already-linked subjects remain usable
  with valid tokens even if the remote email is unverified.
- A nonce derived from Better Auth's random PKCE verifier binds each token to its
  one-use sign-in state. The generic and social sign-in/link routes share this guard.
- Discovery must name the configured issuer and HTTPS endpoints on that issuer's
  origin before an authorization URL is returned or a code/secret is exchanged.
- Failed validation returns the existing safe authentication error flow. Tokens,
  claims and provider error bodies are not included in new diagnostics.

No schema change, new credential or dependency is required. An OAuth attempt started
before deployment has no nonce and must be restarted; existing local sessions remain
unchanged. Do not change MAESTRO_ISSUER to another provider/environment while retaining
the same stored provider identities without an explicit identity-migration review.

## Evidence and compatibility limits

The Node regression fixture (`api/scripts/maestro-oidc.node.ts`) exercises actual
Better Auth HTTP endpoints with the production provider factory, synthetic users,
in-memory storage and intercepted provider responses. It verifies valid sign-in,
linking, key rotation, invalid claims/signatures/nonces, replay, outages and safe
errors. It is not a live Maestro login or proof of production account compromise.

The 2026-10-05 provider discovery advertises RS256, EdDSA and unsigned tokens, and
several client authentication methods. Those lists do not establish the method or
algorithm used by this registration. The code preserves the existing secret-post
exchange and requires signed ID tokens. There is no fallback to unsigned identity
claims or to an unverified userinfo response when required claims are missing.

## Before production release

1. Confirm this registration's actual client authentication method and signing
   algorithm with the integration owner. Confirm Maestro echoes the requested nonce
   and supplies correctly typed identity claims. A provider contract change must be
   reviewed rather than silently weakening these checks.
2. Rehearse an authorized real sign-in, an already-linked user, first linking after
   mailbox setup, reduced consent, an unavailable provider, password recovery and
   local sign-out. Do not grant new organizations or send test mail incidentally.
3. Release with the invitation-ownership prerequisite. Keep its public-signup and
   mailbox-verification protections. If Maestro compatibility fails, pause Maestro
   sign-in and preserve the tested local recovery route; do not restore permissive
   token/account-linking behavior as a rollback.
4. Record the source revision, results, accountable owner and go/no-go decision.
   Review historical unverified accounts and suspicious access separately; this
   patch does not retrospectively prove ownership or revoke existing sessions.

Current backup service logs show successful nightly uploads through 2026-10-05;
archive integrity, a current restore drill and attachment recovery remain separate
release evidence. This authentication patch performs no historical data repair.

## Rehearsal evidence — 2026-10-14

- Identity source: `dd9d7b45e2a15bc39660e8b998d2370d53db5194`, integrated with
  main `02852af5512f1d0e4e73d2c6b24ed58191b2155a`. The CI conflict was resolved
  by retaining both the identity fixture and main's PDF/runtime checks.
- Automated: all 80 synthetic-provider checks passed on Node 22.23.2 and Node
  24.16.0; 30 focused authentication, invitation and session tests passed on
  isolated PostgreSQL 17. Typecheck, dependency audit (no vulnerabilities),
  frontend build, 24 route and seven detail smokes, bridge/import/header checks
  and a manual review of the identity/linking boundary passed. Dedicated SAST
  and secret scanners were not installed.
- Live: the existing ACTIVE Service Desk registration permits the localhost
  callback. A designated existing Maestro user signed into the PR's Node 22
  API against a separate local database, then signed in again with the same
  linked identity. The actual client-secret-post exchange succeeded; the
  validated ID token used RS256, the expected issuer/audience, a nonce,
  boolean verified email and integer expiry/issued-at claims. No token or
  raw claim payload is included in this evidence. No production data changed.
- Local sign-out returned to authentication; reloading stayed signed out.
  The stale brand picker remained visible immediately after sign-out until
  reload. This existing frontend issue remains outside this conflict update.
  A subsequent server-side check found a release blocker: the shared browser
  sign-out POST has neither a JSON content type nor a body. It returns HTTP
  415 and leaves the server session valid. Reproducing the same request with
  `Content-Type: application/json` alone returned 400; supplying that header
  and an empty JSON object returned 200 and removed the targeted session.
  The request fix and its regression coverage require a separately approved
  change; the production code has not been altered by this diagnosis.
- Recovery completed: the requester confirmed receiving the reset email and
  submitting the new password. The isolated database contains the password
  credential and verified mailbox; all sessions predating the reset are gone.
  The recovered user's local dashboard session was verified in the browser.
- First linking after mailbox setup passed. Only the isolated user's Maestro
  account link was removed; the verified local user and password credential
  remained. A fresh real Maestro sign-in linked back to that same local user.
- Reduced-scope consent passed through the existing explicit-link endpoint:
  only `openid`, `profile` and `email` were requested and returned. Token
  validation/linking succeeded; workspace access failed safely with the
  browser message `Insufficient permissions`. Normal sign-in restored the
  configured scope set afterward. The registration and production scopes
  were not changed.
- A discovery HTTP 503 was simulated in the isolated Node API, without
  disrupting Maestro. The real login route returned its expected safe
  unavailable-provider redirect, which the browser displayed. The temporary
  harness asserted the isolated database, local callback, requested scopes,
  nonce and error redirect; it is not part of the production code.
- Integrated revision `7e418ed4b7bc010ab97797dc90170e24a83d9839` passed CI and
  Octopus re-review (4/5, zero findings).
- Technical rehearsal: **NO-GO pending the server sign-out fix above**.
  The identity, recovery, first-linking, reduced-scope and outage checks
  passed; the existing stale-picker UI issue is also recorded.
  Production release remains pending requester authorization.
  This evidence update does not authorize a production merge or deployment.
