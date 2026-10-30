# Company-server staging

Staging uses a separate Dokploy environment in the existing `respovia` project.
Provisioning is in progress; this runbook does not certify a completed deployment.

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
Keep it unlisted and install only in the approved test organisation,
`Jodi's Organisation` (`53d2875b-51cd-414d-afe7-27b68fe8b03a`). Its platform
approval is pending; do not use production credentials to bypass that gate.

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

Deploy the database, then the API, then the web service, one at a time. Check API
`/api/v1/health` and `/api/v1/health/ready`, Maestro callback/sign-in, authenticated
workspace access, unauthenticated denials, test ticket operations and isolated
uploads. Verify production health after infrastructure changes.

Promote code through normal reviewed PRs; never promote staging credentials or
test data. Roll back code using Dokploy deployment history. Migrations are not
undone by code rollback; repair a schema with a forward migration.

The existing Vercel configuration remains during verification. Retire it only
after the company staging environment passes its checks.
