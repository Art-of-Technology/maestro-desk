-- Custom-domain support for the customer portal. A workspace admin
-- can claim a hostname (e.g. help.acme.com) and serve the portal
-- there instead of the platform-default URL with ?ws=<slug>.
--
-- Flow:
--   1. Admin sets portal_custom_domain. Server stamps
--      portal_custom_domain_token (random) and resets verified=false.
--   2. Admin adds a TXT record at _maestro-verify.{host} with the
--      token as the value, then clicks Verify.
--   3. Server resolves the TXT, compares, sets verified=true on
--      match. Until verified, the portal won't resolve the host.
--   4. Admin points the hostname (CNAME / A) at their own CDN /
--      proxy that forwards to our portal host. TLS is their
--      responsibility — we don't terminate it for them.
--
-- Unique constraint prevents two workspaces from claiming the same
-- hostname. Case-insensitive via lower() index because DNS itself is
-- case-insensitive.

alter table workspaces
  add column portal_custom_domain          text,
  add column portal_custom_domain_token    text,
  add column portal_custom_domain_verified boolean not null default false;

create unique index workspaces_portal_custom_domain_unique
  on workspaces (lower(portal_custom_domain))
  where portal_custom_domain is not null;

alter table workspaces
  add constraint portal_custom_domain_shape check (
    portal_custom_domain is null
    or portal_custom_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  );
