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
