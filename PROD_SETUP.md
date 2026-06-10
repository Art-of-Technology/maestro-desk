# Production setup — internal cutover (clean-slate)

Standing up Maestro Desk for **internal use** (your team replaces Zoho Desk). Clean-slate: new tickets start here; old Zoho tickets stay in Zoho until they close out. No data migration.

Stack (post Supabase→Neon migration): **Neon** (Postgres, source of truth) · **Better Auth** (sign-in/sessions, owns its tables in Neon) · **Cloudflare R2** (brand-asset uploads) · **Vercel** (SPA static files **and** the Hono API as serverless functions; see §3) · **Postmark** (email). Domain: **maestro-desk.com** — `desk.maestro-desk.com` (agent app) · `help.maestro-desk.com` (portal) · `api.maestro-desk.com` (API) · `support@maestro-desk.com` (email).

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
> **Decided (Step 6).** The API runs on **Vercel** (Hono via the Vercel adapter) at **`https://api.maestro-desk.com`** — the SPA/portal point prod there (`index.html`/`portal.html`), and the Fly config (`fly.toml`, `Dockerfile`, `.dockerignore`) has been removed from the repo. Do **not** add new Fly config. Two things to get right on the Vercel deploy:
> - **Background work is already serverless-ready (no code change needed).** The in-process workers (`startWebhookWorker`/`startCsatReminderWorker`) run **only** in local dev (`src/dev.ts`, never imported on Vercel). On Vercel, webhook first-attempts fire inline via `waitUntil`, and the retry sweep + daily CSAT reminders run as **Vercel Cron** jobs (`vercel.json` → `/api/v1/cron/*`, handled by `routes/cron.ts`); both sweeps claim work with `FOR UPDATE SKIP LOCKED` / a conditional `UPDATE`, so concurrent or duplicate invocations are safe. **The only gate: set `CRON_SECRET` in the Vercel env** — without it the cron endpoints 401 and nothing sweeps (the API logs a warning at boot). Retries currently sweep once daily (Hobby-plan cadence); raise the `vercel.json` frequency on Pro if you want the backoff schedule honored.
> - `BETTER_AUTH_URL` must equal the API's **public** origin so session tokens sign/verify correctly.

Prod secrets to set on the API host (no `SUPABASE_*`):
```sh
DATABASE_URL=postgresql://…@…neon.tech/…?sslmode=require
BETTER_AUTH_SECRET=<openssl rand -base64 32>      # REQUIRED — app won't boot without it
BETTER_AUTH_URL=https://api.maestro-desk.com       # the API's own public origin
APP_BASE_URL=https://desk.maestro-desk.com         # SPA origin: trusted origin + reset-link base
ANTHROPIC_API_KEY=…
POSTMARK_INBOUND_SECRET=<random 16+ chars>
POSTMARK_SERVER_TOKEN=…  POSTMARK_OUTBOUND_FROM=support@maestro-desk.com
POSTMARK_ACCOUNT_TOKEN=…  POSTMARK_INBOUND_REPLY_ADDRESS=…@inbound.postmarkapp.com
PORTAL_BASE_URL=https://help.maestro-desk.com/portal.html
CRON_SECRET=<openssl rand -base64 32>              # REQUIRED on Vercel — signs cron invocations; unset = /api/v1/cron/* 401s and no sweeps run
# Cloudflare R2 (brand-asset/logo uploads):
R2_ACCOUNT_ID=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…
R2_BUCKET=brand-assets  R2_PUBLIC_BASE_URL=https://<pub-…r2.dev or custom domain>
```
- [ ] 👤 Deploy the API; verify `GET /api/v1/health` = 200 and `GET /api/v1/health/ready/neon` proves Neon connectivity.
- [ ] 👤 **Vercel (SPA):** deploy the static frontend (repo root — `index.html`, `portal.html`, `js/`, `styles/`) and bind `desk.maestro-desk.com` (app) + serve `portal.html` at `help.maestro-desk.com`. The SPA picks its API base by hostname (inline script in `index.html`) — confirm the prod hosts resolve to the deployed API at `https://api.maestro-desk.com`. There is **no** `/api/v1/config` fetch anymore.

## 4. Auth cutover (the flip goes live here)
This is atomic: the API verifies Better Auth sessions and the SPA signs in via Better Auth — **deploy them together**.
- [ ] 👤 Deploy the **API and SPA from the same `main` commit** in one window. A new SPA against an old API (or vice-versa) breaks login.
- [ ] 👤 **Re-invite / reset every existing user.** Supabase password hashes do **not** carry over (Better Auth stores credentials in Neon's `account` table). Per user: 🤖 `POST /api/v1/god/brands/:id/invite {email}` (creates the Better Auth user if absent + emails a set-password link via Postmark), or `POST /api/auth/request-password-reset {email}` for an existing account. The link lands at `https://desk.maestro-desk.com/?reset_token=…` → the SPA's set-password panel.
- [ ] 👤 Confirm `BETTER_AUTH_SECRET` + `APP_BASE_URL` + `BETTER_AUTH_URL` are set (above) — the reset email and trusted-origin checks depend on them.

## 5. Email (Postmark) + DNS
- [ ] 👤 In Postmark, add your sending **Domain** (not just a signature) → it returns DKIM + Return-Path records.
- [ ] 👤 Add DNS records on `maestro-desk.com`:
  - **DKIM** + **Return-Path (CNAME)** — from Postmark
  - **SPF (TXT @):** `v=spf1 a mx include:spf.mtasv.net ~all`
  - **DMARC (TXT _dmarc):** `v=DMARC1; p=none; pct=100; rua=mailto:rua@dmarc.postmarkapp.com` (monitoring; tighten after ~2 weeks)
  - **MX** on the support domain → `inbound.postmarkapp.com` so inbound mail hits the webhook
  - **CNAMEs** for `desk` / `help` → the Vercel SPA deployment, and `api` → the Vercel API deployment
- [ ] 👤 Verify the domain in Postmark (DKIM + Return-Path) — DNS can take minutes–hours.
- [ ] 👤 Configure the Postmark inbound webhook → `https://api.maestro-desk.com/api/v1/webhooks/postmark/inbound?secret=<POSTMARK_INBOUND_SECRET>`.
- [ ] 🤖 Add the support domain to `workspace_email_domains` so inbound routes to your workspace (not the unrouted bucket).

## 6. Smoke + pilot
- [ ] 👤 Agent signs in at `desk.maestro-desk.com` with their **Better-Auth** password (set via the reset link) — confirm the workspace shell loads (not the demo persona).
- [ ] 👤 Platform admin (`jodi@…`) signs in → the god panel is reachable; create a brand + invite an owner → owner receives the set-password email.
- [ ] 👤 Send a test email to `support@maestro-desk.com` → confirm a ticket appears and auto-triage populates summary/draft; agent replies → customer receives it from `support@maestro-desk.com`.
- [ ] 👤 Upload a workspace logo in Settings → confirm it renders from the R2 public URL.
- [ ] 👤 Run a few real tickets through before flipping your public support address.
- [ ] 👤 **Cutover:** change where `support@…` mail is delivered from Zoho to Postmark; leave Zoho read-only until open tickets there close.

## Notes
- **Background workers + Vercel:** already handled — the in-process workers are local-dev-only; on Vercel the same work runs via inline `waitUntil` (first webhook attempt) + Vercel Cron (`/api/v1/cron/*`, concurrency-safe). Going live just needs `CRON_SECRET` set in the Vercel env (see §3).
- **CORS:** the API restricts browser origins on authenticated routes to `APP_BASE_URL` + `localhost:5173` (`api/src/index.ts`); the public/portal API (`/api/v1/public/*`) stays open so white-label portals on verified custom domains keep working. So `APP_BASE_URL` must be set correctly in prod (`https://desk.maestro-desk.com`) or the agent SPA's own API calls get blocked.
- The emailed reset/set-password token lands at `${APP_BASE_URL}/?reset_token=…`; the SPA strips it from the URL on load.
- Migrations are plain SQL in `db/migrations/`, applied with `bun run migrate`; validate on Docker PG 17 before pushing (see `CLAUDE.md`).
- Remaining migration steps after auth: **Step 5 (Pubby realtime)** and **Step 7 (cleanup)**. **Step 6 (Vercel + retire Fly)** is done in code — Fly artefacts removed, SPA/portal repointed, and the cron-driven background work is wired; the only Step-6 leftover is the operational `CRON_SECRET` + deploy.
