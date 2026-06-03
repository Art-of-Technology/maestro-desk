# Production setup — internal cutover (clean-slate)

Standing up Maestro Desk for **internal use** (your team replaces Zoho Desk). Clean-slate: new tickets start here; old Zoho tickets stay in Zoho until they close out. No data migration.

Stack: **Supabase** (new prod project) · **Fly.io** (Bun/Hono API) · **Cloudflare Pages** (SPA) · **Postmark** (email). Domain: **maestro-desk.com** — `desk.maestro-desk.com` (agent app) · `help.maestro-desk.com` (portal) · `support@maestro-desk.com` (email).

> Legend: 🤖 = Claude can do it (Supabase Management API / repo) · 👤 = you (billing, DNS, account auth).

## Status (prod stood up 2026-06-03)
Prod Supabase project: **`maestro-desk-prod`** · ref **`lswyvrohumwbszegmybx`** · eu-central-1 · Free.
**Done:** project created · all migrations applied (52 tables, 56 policies) · `site_url` + redirect allow-list set · Custom Access Token Hook enabled.
**Your immediate action:** reset the prod DB password (Dashboard → Settings → Database) — the generated one is held nowhere.
**Pending:** real-workspace + agents bootstrap · Fly deploy · Cloudflare Pages domain wiring · Postmark domain + DNS.

## 1. Supabase prod project ✅
- [x] 🤖 Project created via Management API — ref `lswyvrohumwbszegmybx`, region eu-central-1, Free.
- [x] 🤖 Migrations applied (`supabase db push --db-url …`) — 52 tables, 56 policies.
- [x] 🤖 `site_url` → `https://desk.maestro-desk.com` + redirect allow-list for `desk.`/`help.`.
- [x] 🤖 Custom Access Token Hook enabled → `pg-functions://postgres/public/custom_access_token_hook`. **(RLS depends on this — done via API, not the dashboard.)**
- [ ] 👤 Reset the prod DB password (Dashboard → Settings → Database) — the generated one isn't stored anywhere. Upgrade to Pro when you want daily backups + HIBP.

## 2. Bootstrap your real workspace (clean-slate, not the demo seed)
- [ ] 🤖 Create your workspace via `public.provision_brand(...)` (seeds roles + permissions + status/priority/category lookups + business hours). Supply your company name/slug + categories.
- [ ] 🤖 Set `is_platform_admin = true` on `jodi@weezboo.com`.
- [ ] 👤 Invite your support agents (auth users) → 🤖 add them to `workspace_members` with the Agent/Admin role.
- [ ] 🤖 Do **not** load the demo seed (TK-001 etc.) into prod.

## 3. API on Fly.io
- [ ] 👤 `fly auth login` (your Fly account).
- [ ] 👤 From `api/`: `fly launch --no-deploy` (uses the committed `fly.toml`/`Dockerfile`; don't let it overwrite them).
- [ ] 👤 Set secrets (values from prod Supabase + Anthropic + Postmark):
  ```sh
  fly secrets set \
    SUPABASE_URL=https://lswyvrohumwbszegmybx.supabase.co \
    SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
    ANTHROPIC_API_KEY=... \
    POSTMARK_INBOUND_SECRET=<random 16+ chars> \
    POSTMARK_SERVER_TOKEN=... POSTMARK_OUTBOUND_FROM=support@maestro-desk.com \
    POSTMARK_ACCOUNT_TOKEN=... POSTMARK_INBOUND_REPLY_ADDRESS=...@inbound.postmarkapp.com \
    PORTAL_BASE_URL=https://help.maestro-desk.com/portal.html
  ```
- [ ] 👤 `fly deploy` → note the app URL (`https://maestro-desk-api.fly.dev`). Verify `GET /api/v1/health` = 200 and `/health/ready` proves DB connectivity.
- [ ] 👤 (optional) Point `api.maestro-desk.com` at the Fly app.

## 4. Frontend (Cloudflare Pages)
- [ ] 👤 Point the existing Pages project at prod: the SPA reads `GET /api/v1/config` for `supabase_url`/`anon_key`, so set the **API base URL** it calls to the Fly app (or `api.maestro-desk.com`).
- [ ] 👤 Bind the domain → `desk.maestro-desk.com` (app) and serve `portal.html` at `help.maestro-desk.com`.
- [ ] 👤 Redeploy; confirm agent login works end-to-end (real Supabase auth, not demo persona).

## 5. Email (Postmark) + DNS
- [ ] 👤 In Postmark, add your sending **Domain** (not just a signature) → it returns DKIM + Return-Path records.
- [ ] 👤 Add DNS records on `maestro-desk.com`:
  - **DKIM** + **Return-Path (CNAME)** — from Postmark
  - **SPF (TXT @):** `v=spf1 a mx include:spf.mtasv.net ~all`
  - **DMARC (TXT _dmarc):** `v=DMARC1; p=none; pct=100; rua=mailto:rua@dmarc.postmarkapp.com` (monitoring; tighten after ~2 weeks)
  - **MX** on your support domain → Postmark inbound (`inbound.postmarkapp.com`) so inbound mail hits the webhook
  - **CNAMEs** for `desk` / `help` → Cloudflare Pages; `api` → Fly (if used)
- [ ] 👤 Verify the domain in Postmark (DKIM + Return-Path) — DNS can take minutes–hours.
- [ ] 👤 Configure Postmark inbound webhook URL → `https://<api>/api/v1/webhooks/postmark/inbound?secret=<POSTMARK_INBOUND_SECRET>`.
- [ ] 🤖 Add your support domain to the workspace (`workspace_email_domains`) so inbound routes to it (not the unrouted bucket).

## 6. Smoke + pilot
- [ ] 👤 Send a test email to `support@maestro-desk.com` → confirm a ticket appears, auto-triage populates summary/draft.
- [ ] 👤 Agent logs in at `desk.maestro-desk.com`, opens the ticket, replies → customer receives it from `support@maestro-desk.com`.
- [ ] 👤 Run a few real tickets through before flipping your public support address.
- [ ] 👤 **Cutover:** change where `support@…` mail is delivered from Zoho to Postmark; leave Zoho read-only until open tickets there close.

## Notes
- The API must run as **one always-on machine** (background workers) — don't scale to zero or past 1 (see `fly.toml`).
- HIBP leaked-password protection requires Supabase **Pro**.
- Migrations are validated on Docker PG 17 before any push (see `CLAUDE.md`).
