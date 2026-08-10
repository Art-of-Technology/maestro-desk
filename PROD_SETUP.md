# Production setup — internal cutover (clean-slate)

Standing up Respovia for **internal use** (your team replaces Zoho Desk). Clean-slate: new tickets start here; old Zoho tickets stay in Zoho until they close out. No data migration.

Stack (post Supabase→Neon migration): **Neon** (Postgres, source of truth) · **Better Auth** (sign-in/sessions, owns its tables in Neon) · **Cloudflare R2** (brand-asset uploads) · **Vercel** (SPA static files **and** the Hono API as serverless functions; see §3) · **Postmark** (email).

> **URLs (2026-08-10).** The product domain is **`respovia.com`** (registered 2026-08-10, Cloudflare Registrar; DNS at Cloudflare, records DNS-only/grey-cloud because Vercel terminates TLS). Production hosts:
> | Role | Production URL | Legacy interim URL (pre-cutover) |
> |---|---|---|
> | API (`maestro-desk-zjkl`) | `https://api.respovia.com` | `https://maestro-desk-zjkl.vercel.app` |
> | Agent app (`maestro-desk` SPA) | `https://app.respovia.com` | `https://maestro-desk-jodi-1420s-projects.vercel.app` |
> | Portal | `https://app.respovia.com/portal.html` | `…vercel.app/portal.html` |
> | Support email | `support@respovia.com` (see §5) | — |
>
> Notes:
> - **`app.respovia.com` is the only fully working agent-app host.** The API's CORS + Better Auth trusted-origin allowlist is `APP_BASE_URL` alone, so on any other host — the apex/www, the legacy `maestro-desk-jodi-1420s-projects.vercel.app` after the env cutover, the old `service-desk-six.vercel.app` alias — the SPA either renders-but-can't-sign-in (origin-blocked) or falls back to `localhost:3001` entirely. Always use `app.respovia.com`.
> - **The apex/www 308 redirect → `app.respovia.com` is REQUIRED** (Vercel → `maestro-desk` project → Settings → Domains). Without it, visitors on `respovia.com` get a rendered SPA whose sign-in fails with opaque CORS errors. Do not "fix" that by widening the server allowlist.
> - **Domain wiring checklist (do once, before the env cutover):**
>   1. Vercel: `api.respovia.com` attached to `maestro-desk-zjkl`; `app.respovia.com` + apex + `www` attached to `maestro-desk` (apex/www set to redirect).
>   2. Cloudflare DNS (**DNS-only/grey-cloud** — the proxy breaks Vercel TLS): `CNAME app → cname.vercel-dns.com`, `CNAME api → cname.vercel-dns.com`, apex/www per the records Vercel shows on the domain entries.
>   3. Wait until all four hosts serve valid certs before flipping any env var. (The post-deploy healthcheck can merge any time — it probes the legacy hosts with a warning until the new domains are provisioned.)
> - **Cutover ordering (breaks SSO if violated):** the Maestro OAuth `redirect_uri` is derived from `BETTER_AUTH_URL` at runtime, but the platform only accepts URIs registered in the **approved** manifest. Editing `maestro.yml` in-repo is inert — submit `maestro apps diff` → `maestro apps revise` and wait for approval **before** setting `BETTER_AUTH_URL=https://api.respovia.com`, or every "Sign in with Maestro" is rejected as an unregistered redirect URI until approval lands.
> - **At the env cutover, also flip `CUTOVER_COMPLETE: "true"`** in `.github/workflows/post-deploy-healthcheck.yml` — that turns an unreachable respovia.com host from a warn-and-probe-legacy condition into the hard failure it then actually is.
> - The legacy `*.vercel.app` entries in `api-base.js`, the CSP `connect-src`, and `maestro.yml` keep the OLD host working until the env cutover; after the flip the old host is CORS-blocked by design (tell the team to switch bookmarks). Remove the entries in a cleanup PR after the soak.

> Legend: 🤖 = Claude can do it (repo / Neon SQL via Management or psql) · 👤 = you (billing, DNS, account auth, deploy).

> **Supabase is gone.** The codebase no longer contains `@supabase/supabase-js`, any `SUPABASE_*` env var, or RLS — authorization is per-route in the Hono API, and auth is Better Auth on Neon. Any older instructions that referenced a Supabase prod project, the Custom Access Token Hook, or `SUPABASE_*` secrets are obsolete.

## Status
**Migration complete (code):** all data access, file storage (R2), and auth (Better Auth) are off Supabase and merged to `main`. The auth flip was verified end-to-end on Neon dev (API smoke + browser login).
**Not yet live:** prod env/secrets, the coordinated API+SPA deploy, and re-inviting users — the steps below.

## 1. Database — Neon (source of truth)
- [ ] 👤/🤖 Confirm the **prod** Neon project/branch exists and you hold its pooled connection string (`postgresql://…@…neon.tech/…?sslmode=require`). This is `DATABASE_URL`.
- [ ] 🤖 Apply migrations to prod: `cd api && DATABASE_URL=<prod> bun run migrate` (transactional, tracked in `schema_migrations`; re-running is idempotent). Confirms the full schema incl. the Better Auth tables (`session`/`account`/`verification`).
- [ ] 🤖 Smoke a raw read against prod (`select count(*) from workspaces`).

## 2. Bootstrap your real workspace (clean-slate, not the demo seed)
- [ ] 🤖 Create your workspace via `select provision_brand(<name>, <slug>, …)` — seeds roles + permissions + status/priority/category lookups + business hours. Returns the new workspace id.
- [ ] 🤖 Create your platform-admin user **through Better Auth** (`POST /api/auth/sign-up/email` against the prod API, or `auth.api.signUpEmail`), then `update users set is_platform_admin = true where email = 'jodi@weezboo.com'` and add a `workspace_members` row (Admin role). The credential lives in Neon's `account` table.
- [ ] 🤖 Do **not** load the demo seed (TK-001 etc.) into prod.

## 3. Hosting — API + SPA
> **Decided (Step 6).** The API runs on **Vercel** (Hono via the Vercel adapter) at **`https://api.respovia.com`** — the SPA/portal point prod there (via `web/js/api-base.js`), and the Fly config (`fly.toml`, `Dockerfile`, `.dockerignore`) has been removed from the repo. Do **not** add new Fly config. Two things to get right on the Vercel deploy:
> - **Background work is already serverless-ready (no code change needed).** The in-process workers (`startWebhookWorker`/`startCsatReminderWorker`) run **only** in local dev (`src/dev.ts`, never imported on Vercel). On Vercel, webhook first-attempts fire inline via `waitUntil`, and the retry sweep + daily CSAT reminders run as **Vercel Cron** jobs (`vercel.json` → `/api/v1/cron/*`, handled by `routes/cron.ts`); both sweeps claim work with `FOR UPDATE SKIP LOCKED` / a conditional `UPDATE`, so concurrent or duplicate invocations are safe. **The only gate: set `CRON_SECRET` in the Vercel env** — without it the cron endpoints 401 and nothing sweeps (the API logs a warning at boot). Retries currently sweep once daily (Hobby-plan cadence); raise the `vercel.json` frequency on Pro if you want the backoff schedule honored.
> - `BETTER_AUTH_URL` must equal the API's **public** origin so session tokens sign/verify correctly.

Prod secrets to set on the API host (no `SUPABASE_*`):
```sh
DATABASE_URL=postgresql://…@…neon.tech/…?sslmode=require
BETTER_AUTH_SECRET=<openssl rand -base64 32>      # REQUIRED — app won't boot without it
BETTER_AUTH_URL=https://api.respovia.com   # the API's own public origin
APP_BASE_URL=https://app.respovia.com      # SPA origin: trusted origin + reset-link base
ANTHROPIC_API_KEY=…
POSTMARK_INBOUND_SECRET=<random 16+ chars>
POSTMARK_SERVER_TOKEN=…  POSTMARK_OUTBOUND_FROM=support@respovia.com   # needs the domain verified in Postmark (see §5)
POSTMARK_ACCOUNT_TOKEN=…  POSTMARK_INBOUND_REPLY_ADDRESS=…@inbound.postmarkapp.com
PORTAL_BASE_URL=https://app.respovia.com/portal.html
CRON_SECRET=<openssl rand -base64 32>              # REQUIRED on Vercel — signs cron invocations; unset = /api/v1/cron/* 401s and no sweeps run
# Cloudflare R2 (brand-asset/logo uploads):
R2_ACCOUNT_ID=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…
R2_BUCKET=brand-assets  R2_PUBLIC_BASE_URL=https://<pub-…r2.dev or custom domain>
```
- [ ] 👤 **R2 asset-domain headers (audit #7, config half):** new uploads store `Content-Disposition: attachment` (set by the API at PUT time), but `X-Content-Type-Options: nosniff` can't be stored as S3 object metadata — add it at the serving layer. On a custom asset domain: Cloudflare → Rules → Transform Rules → Modify Response Header → add `X-Content-Type-Options: nosniff` for the asset hostname. (Not possible on a bare `pub-….r2.dev` URL — becomes available once the domain is registered and the bucket gets a custom domain.)
- [ ] 👤 Deploy the API; verify `GET /api/v1/health` = 200 and `GET /api/v1/health/ready/neon` proves Neon connectivity.
- [ ] 👤 **Vercel (SPA):** deploy the static frontend (the **`web/`** directory — `index.html`, `portal.html`, `js/`, `styles/`; the SPA project's **Root Directory must be `web`**, so it builds as pure static with zero functions and never picks up `api/`). The agent app serves at `https://app.respovia.com`. The SPA picks its API base by hostname (`web/js/api-base.js`) — see the URL notes at the top for which hosts are recognized; every other host falls back to `localhost:3001`. There is **no** `/api/v1/config` fetch anymore.

### Post-deploy verification & rollback
- **Automatic health-check.** Every push to `main` runs `.github/workflows/post-deploy-healthcheck.yml`, which polls the live API (`/api/v1/health` + `/api/v1/health/ready`) and SPA root and **fails the Actions run if the deployment is down or Neon is unreachable**. (Limitation: the health routes carry no git-SHA, so it proves the API is up + DB-reachable after the push, not that this exact commit is live.) Watch the **Actions** tab after a deploy; a red "Post-deploy health-check" means the site is unhealthy.
- **Rollback (manual).** Vercel keeps every deployment immutable. To roll back: open the Vercel project → **Deployments** → pick the last-known-good build → **Promote to Production** (or `vercel rollback <deployment-url>` / `vercel promote <deployment-url>`). Do this for **both** projects (`maestro-desk` SPA and `maestro-desk-zjkl` API) if both shipped the bad commit. Note: a rollback reverts **code only** — Neon migrations applied by `migrate.yml` are not undone (they are additive by convention), so a code rollback against a newer schema is safe; a schema that needs reverting requires a new forward migration.

## 4. Auth cutover (the flip goes live here)
This is atomic: the API verifies Better Auth sessions and the SPA signs in via Better Auth — **deploy them together**.
- [ ] 👤 Deploy the **API and SPA from the same `main` commit** in one window. A new SPA against an old API (or vice-versa) breaks login.
- [ ] 👤 **Re-invite / reset every existing user.** Supabase password hashes do **not** carry over (Better Auth stores credentials in Neon's `account` table). Per user: 🤖 `POST /api/v1/god/brands/:id/invite {email}` (creates the Better Auth user if absent + emails a set-password link via Postmark), or `POST /api/auth/request-password-reset {email}` for an existing account. The link lands at `${APP_BASE_URL}/?reset_token=…` (`https://app.respovia.com/?reset_token=…`) → the SPA's set-password panel.
- [ ] 👤 Confirm `BETTER_AUTH_SECRET` + `APP_BASE_URL` + `BETTER_AUTH_URL` are set (above) — the reset email and trusted-origin checks depend on them.

## 5. Email (Postmark) + DNS
> **Unblocked 2026-08-10** — `respovia.com` is registered (DNS at Cloudflare; keep mail records DNS-only).
- [ ] 👤 In Postmark, add your sending **Domain** (not just a signature) → it returns DKIM + Return-Path records.
- [ ] 👤 Add DNS records on `respovia.com` (Cloudflare, DNS-only):
  - **DKIM** + **Return-Path (CNAME)** — from Postmark
  - **SPF (TXT @):** `v=spf1 a mx include:spf.mtasv.net ~all`
  - **DMARC (TXT _dmarc):** `v=DMARC1; p=none; pct=100; rua=mailto:rua@dmarc.postmarkapp.com` (monitoring; tighten after ~2 weeks)
  - **MX ⚠ decision — pick one, the later steps depend on it:**
    - **(a) Apex MX → `inbound.postmarkapp.com`.** `support@respovia.com` accepts directly-addressed mail → the `workspace_email_domains` step below and the §6 "email a ticket into existence" smoke work as written. Cost: ALL `@respovia.com` mail routes to the ticketing webhook — no normal mailboxes (e.g. Google Workspace) on the apex, ever, without redoing this.
    - **(b) No apex MX.** Mailbox options stay open; *replies* to outbound ticket email still thread fine (they ride the `POSTMARK_INBOUND_REPLY_ADDRESS` Reply-To). But directly-addressed mail to `support@respovia.com` **bounces**: skip the `workspace_email_domains` step below, skip the §6 send-an-email smoke, and take email-to-ticket intake from a subdomain (e.g. MX on `support.respovia.com`) or a forwarding rule later.
- [ ] 👤 Verify the domain in Postmark (DKIM + Return-Path) — DNS can take minutes–hours.
- [ ] 👤 Configure the Postmark inbound webhook with **HTTP Basic Auth** (the secret rides in the `Authorization` header, never the URL) → `https://postmark:<POSTMARK_INBOUND_SECRET>@api.respovia.com/api/v1/webhooks/postmark/inbound`. The bounce webhook uses Postmark's HTTP Basic Auth username/password fields (username `postmark`, password = the secret). The `?secret=` query form is no longer accepted.
- [ ] 🤖 *(MX option (a) only)* Add the support domain to `workspace_email_domains` so inbound routes to your workspace (not the unrouted bucket).

## 6. Smoke + pilot
- [ ] 👤 Agent signs in at `https://app.respovia.com` with their **Better-Auth** password (set via the reset link) — confirm the workspace shell loads (not the demo persona).
- [ ] 👤 Platform admin (`jodi@…`) signs in → the god panel is reachable; create a brand + invite an owner → owner receives the set-password email.
- [ ] 👤 *(after §5; MX option (a) only — with option (b) directly-addressed mail bounces by design)* Send a test email to `support@respovia.com` → confirm a ticket appears and auto-triage populates summary/draft; agent replies → customer receives it from `support@respovia.com`. Until then, you can still create tickets manually in-app to exercise the rest of the flow.
- [ ] 👤 Upload a workspace logo in Settings → confirm it renders from the R2 public URL.
- [ ] 👤 Run a few real tickets through before flipping your public support address.
- [ ] 👤 *(after §5 / domain registered)* **Cutover:** change where `support@…` mail is delivered from Zoho to Postmark; leave Zoho read-only until open tickets there close.

## 7. Staging (pre-prod rehearsal)

A rehearsal environment so a bad or **non-additive** migration (one already shipped — `db/migrations/20260619120000_drop_inert_feature_tables.sql`) fails in staging, not prod. Flow:

```
feature branch ──▶ staging   (Vercel staging deploy + migrate-staging.yml → Neon staging-branch DB)
                     │  verify green (health on the staging API host)
                     ▼
                   main       (prod auto-deploy + migrate.yml → prod, exactly as today)
```

This is **rehearsal-only** (the chosen scope): prod's auto-deploy path and its migrate-vs-deploy ordering are unchanged — staging just gives migrations a place to bake first.

**In-repo (this PR):** `.github/workflows/migrate-staging.yml` (applies migrations to the staging DB on push to `staging`, gated by the `staging` Environment) and the staging branches in `web/index.html` / `web/portal.html` API-base routing.

**Manual setup 👤 (staging goes live only after these):**
- [ ] 👤 **Neon:** create a **branch** database off prod (copy-on-write; scales to zero). Capture its pooled connection string.
- [ ] 👤 **GitHub:** create a **`staging` Environment** (Settings → Environments); add secret `DATABASE_URL` = the Neon staging-branch URL; restrict the environment to the **`staging`** branch (mirrors how `production` gates prod in `migrate.yml`).
- [ ] 👤 **Vercel (both projects, `maestro-desk` SPA + `maestro-desk-zjkl` API):** enable deploys for the `staging` branch and set its env vars **scoped to that branch/Preview**: `DATABASE_URL` = Neon staging branch; `APP_BASE_URL` = the staging **SPA** host (so the staging SPA's authenticated calls aren't CORS-blocked — see Notes/CORS); `BETTER_AUTH_URL` = the staging **API** host; plus `PORTAL_BASE_URL`, `BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY`, `POSTMARK_INBOUND_SECRET`, `CRON_SECRET`, and the `R2_*` group (same required set as §3).
- [ ] 👤 **Confirm the staging hostnames.** The SPA routing scaffolds `maestro-desk-git-staging-jodi-1420s-projects.vercel.app` (SPA) → `maestro-desk-zjkl-git-staging-jodi-1420s-projects.vercel.app` (API), the standard Vercel git-branch pattern. After the first staging deploy, verify the actual URLs (Project → Deployments → `staging`) and update `STAGING_API` + the preview-host regex in `web/js/api-base.js` if they differ (or if you assign a custom staging alias) — the hostname logic lives there now, not in `index.html`/`portal.html`. If wrong, the staging SPA falls back to `localhost:3001` and login fails on **staging only**.
- [ ] 👤 **Create the long-lived `staging` branch** off `main` (after this merges, so it carries `migrate-staging.yml`): `git branch staging main && git push -u origin staging`.

**Then, per change:** open a PR → merge to `staging` → staging auto-deploys + `migrate-staging.yml` runs against the Neon branch → verify `GET <staging-api>/api/v1/health/ready` is green and smoke the change → merge `staging` → `main` (prod deploys + prod migrate as today).

## Notes
- **Background workers + Vercel:** already handled — the in-process workers are local-dev-only; on Vercel the same work runs via inline `waitUntil` (first webhook attempt) + Vercel Cron (`/api/v1/cron/*`, concurrency-safe). Going live just needs `CRON_SECRET` set in the Vercel env (see §3).
- **CORS:** the API restricts browser origins on authenticated routes to `APP_BASE_URL` + `localhost:5173` (`api/src/index.ts`); the public/portal API (`/api/v1/public/*`) stays open so white-label portals on verified custom domains keep working. So `APP_BASE_URL` must be set correctly in prod (`https://app.respovia.com`) and must match the host agents actually load, or the agent SPA's own API calls get blocked by CORS.
- The emailed reset/set-password token lands at `${APP_BASE_URL}/?reset_token=…`; the SPA strips it from the URL on load.
- Migrations are plain SQL in `db/migrations/`, applied with `bun run migrate`; validate on Docker PG 17 before pushing (see `CLAUDE.md`).
- Remaining migration steps after auth: **Step 5 (Pubby realtime)** and **Step 7 (cleanup)**. **Step 6 (Vercel + retire Fly)** is done in code — Fly artefacts removed, SPA/portal repointed, and the cron-driven background work is wired; the only Step-6 leftover is the operational `CRON_SECRET` + deploy.
