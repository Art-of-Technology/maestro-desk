# Company-server staging

Staging uses a separate Dokploy environment in the existing `respovia` project.
The web, API and database are deployed. Authenticated acceptance checks are
pending; this runbook does not certify staging as ready to replace Vercel.

| Component | Configuration |
| --- | --- |
| Web | `respovia-staging-web`, `web/Dockerfile`, build context `web` |
| API | `respovia-staging-api`, `api/Dockerfile`, build context `.`; Node 22 |
| Database | `respovia-staging-db`, PostgreSQL 17, internal network only |
| App URL | `https://staging.respovia.com` |
| API URL | `https://staging-api.respovia.com` |
| Deployment branch | `staging-server`; manual Dokploy deployments |

The separate Maestro app is `Respovia Staging`
(`46fc9b1d-0aa3-4e66-b3bc-580bd4313cf7`), managed by `maestro-staging.yml`.
The app is ACTIVE and unlisted, originally installed in `Jodi's Organisation`.
Jodi subsequently approved using Space Casino's Maestro identity for staging;
its Respovia workspace, tickets and files remain in the separate staging stores.
Do not use production app credentials or headless tokens.

Create `staging-server` from the reviewed current code, not the old `staging`
branch. The legacy Neon migration workflow only targets `staging`; do not
dispatch it for this environment. The API container runs migrations against its
own database before startup, matching production.

## Isolation

- Use a fresh database and synthetic tickets, never a production database copy.
- Generate independent database, session, inbound-webhook and cron secrets.
- Set `NODE_ENV=production`, `PORT=3001`, `TRUST_PROXY=1`,
  `APP_BASE_URL=https://staging.respovia.com`,
  `BETTER_AUTH_URL=https://staging-api.respovia.com`, and
  `PORTAL_BASE_URL=https://staging.respovia.com/portal.html`.
- `DATABASE_URL` must use the staging database's internal hostname and
  `sslmode=disable`. Never publish the database port.
- Use a separate Maestro client, staging callback URL and explicitly approved
  test organisation. Keep production client credentials and headless tokens out.
- Set `MAESTRO_ORGANIZATION_ID=cebeb395-48d3-4a27-9c6b-571446b27696` and
  `MAESTRO_ALLOWED_BRAND_ID=58d5016a-91bb-49e6-a9be-b3f36f08afde` in staging
  (Oh My Casino organisation, Space Casino brand).
  This server-side restriction covers discovery, workspace requests and brand
  selection. Leave both unset in production to preserve multi-brand access.
- Keep `MAESTRO_API_TOKEN` empty. Player lookups, imports and background player
  enrichment require that separate token; user sign-in must not enable them.
- Use staging-only R2 buckets and bucket-scoped credentials. Never reuse the
  production attachments, assets or backup bucket credentials.
- Leave Postmark outbound/account credentials, Slack, Pubby, push notifications,
  production deployment relays and other live integrations unset. Do not
  configure production webhook destinations in test data.
- AI calls remain disabled until a staging-only key is configured. The existing
  required `ANTHROPIC_API_KEY` field can contain a non-secret, deliberately invalid
  staging placeholder during infrastructure verification; AI features will fail
  clearly rather than consume production credits.
- Cloudflare Tunnel routes must target the staging services directly: web port
  80 and API port 3001. Preserve all existing production ingress routes.

## Deploy and verify

Provisioned on 2026-10-30:

- Dokploy environment: `staging`; API service `respovia-staging-api-eqkcgf`,
  web service `respovia-staging-web-dwk2lr`, database `respovia-staging-db-1roohi`.
- The existing Cloudflare tunnel routes the two staging hostnames to those
  services. All four production routes remain unchanged.
- R2 buckets: `respovia-staging-assets` (public synthetic logos) and
  `respovia-staging-attachments` (private), with credentials scoped to these two
  buckets. Asset base URL: `https://pub-1b80c560c72a45a99fa8bc0d517adf99.r2.dev`.
  The development URL is rate-limited and only intended for staging.
- Automatic deployments and environment-file generation are disabled for both
  applications. API secrets are runtime configuration, never frontend files.
- All 149 migrations applied. Staging and production readiness returned 200;
  staging frontend returned 200, unauthenticated tickets returned 401, and
  `/.env` returned 404. CORS allowed the staging frontend and rejected an
  unrelated origin. Maestro is enabled and its sign-in page loads.
- Maestro sign-in completed. The initial brand picker included other
  organisations, so the staging API now enforces `MAESTRO_ORGANIZATION_ID`.
  After deploying `412937a`, refreshing the picker returned no available brands,
  matching the empty approved test organisation. Restriction tests, typecheck
  and CI passed; Octopus reviewed that commit with zero findings (4/5).
- Historical blocker: Maestro rejected creation of `Respovia Staging Test` in Jodi's
  Organisation with "You do not have permission to create brands in this
  organization", although the CLI reports `ORGANIZATION_ADMIN`. No brand was
  created. Jodi approved using Space Casino instead, with synthetic tickets and
  player lookups/outbound integrations disabled. No new Maestro brand is needed.
- Still required: grant the verified Maestro identity staging administration,
  approve the synthetic workspace, and verify ticket operations and isolated
  uploads. Vercel retirement remains on hold.

Deploy the database, then the API, then the web service, one at a time. Check API
`/api/v1/health` and `/api/v1/health/ready`, Maestro callback/sign-in, authenticated
workspace access, unauthenticated denials, test ticket operations and isolated
uploads. Verify production health after infrastructure changes.

Promote code through normal reviewed PRs; never promote staging credentials or
test data. Roll back code using Dokploy deployment history. Migrations are not
undone by code rollback; repair a schema with a forward migration.

The existing Vercel configuration remains during verification. Retire it only
after the company staging environment passes its checks.
