# Better Auth 1.7 upgrade

Upgrade `better-auth` and its bundled adapters from 1.6.23 to 1.7.14 together.
The moderate-or-higher dependency audit stays enabled without exceptions.

## Compatibility

- Accounts still use `(providerId, accountId)`. Version 1.7.3 reverted the
  temporary issuer-column requirement from 1.7.0–1.7.2. Respovia's migrations
  do not add that column, so this upgrade needs no database migration or backfill.
- Maestro remains the identity provider. Its existing signed-identity checks
  now register through Better Auth's social-provider interface. Discovery is
  validated before using any endpoint; a provider outage does not prevent
  local session handling. The authorization flow uses Better Auth's native
  one-use state, PKCE and nonce instead of the former nonce-rewriting hook.
- The registered `/api/auth/oauth2/callback/maestro` URL remains valid. A fixed
  redirect sends its query to the shared callback. `callbackPath` preserves
  the registered redirect URI during both authorization and code exchange.
  No Maestro app registration changes are required.
- Gateway token retrieval lists the authenticated user's accounts, selects
  the Maestro row, and passes its local row ID to `getAccessToken`. Provider
  subject IDs are never used as local row IDs. Token refresh revalidates
  discovery and keeps the existing `client_secret_post` authentication.
- Existing user IDs, sessions, invitation activation and password-reset
  behavior are retained. Direct client-supplied Maestro ID tokens remain
  unsupported; linking still requires both email addresses to be verified.

## Deployment checks

Before deployment, check for duplicate account keys without returning subjects:

```sql
select count(*) as duplicate_keys
from (
  select 1 from account group by "providerId", "accountId" having count(*) > 1
) duplicates;
```

Stop if the count is nonzero; do not merge users or delete accounts automatically.
Deploy the dependency and compatibility changes together. Verify Maestro
sign-in, the session bridge, an existing linked agent's gateway access, and
session revocation. Do not send customer messages as a smoke test.

Rollback is a deployment of the previous API image; there is no schema change
to reverse. An OAuth flow started before either deployment may need to be
restarted because nonce handling changed. Stored sessions and account links
do not need clearing.

References: [current upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide)
and [1.7.14 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.14).
