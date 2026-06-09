# Maestro Desk — Engineering Setup Overview

> Audience: a new engineer (and the CTO). Every claim below is taken from the actual files in this repo; file paths are cited inline. Anything that could **not** be verified from the files is called out under **⚠️ Cannot verify from files**.

---

## 0. Expectation vs. reality (read this first)

The stack was expected to be *Bun, TypeScript, Next.js, Prisma/Drizzle, Postgres, a Next.js app framework, and a Hono API*. Here is what the files actually show:

| Expected | Reality | Verdict |
|---|---|---|
| **Bun** | Bun runs the API and all tooling (build, smokes, static server). | ✅ Correct |
| **TypeScript** | API only (`api/`, TS 5.6). **The frontend is plain JavaScript ES modules** (68 `.js` files in `js/`), not TypeScript. | ⚠️ Half right — backend only |
| **Next.js** | **Not present.** No Next.js, no React, no framework, no bundler in production. The frontend is a hand-written vanilla-JS ES-module SPA served as a static `index.html`. | ❌ Wrong |
| **Prisma / Drizzle** | **Neither.** No ORM at all. Data access is `@supabase/supabase-js` (PostgREST). Migrations are raw `.sql` files applied by the Supabase CLI. | ❌ Wrong |
| **Postgres** | Yes — managed Postgres **17** via Supabase. | ✅ Correct |
| **Next.js app framework** | Same as above — no framework. | ❌ Wrong |
| **Hono API** | Yes — Hono 4.6 on Bun. | ✅ Correct |

**The two big surprises for an incoming engineer:** there is **no Next.js / React** (the UI is framework-less vanilla JS), and **no ORM** (Supabase client + SQL migrations). The only `package.json` in the repo is `api/package.json` — the frontend has no package manifest, no dependencies, and no build step in production.

---

## 1. Language & runtime (with versions)

- **Runtime: Bun.** Source of truth varies by context (no single pinned version file):
  - CI pins **Bun 1.3.13** — `.github/workflows/ci.yml` (`oven-sh/setup-bun@v2`, `bun-version: "1.3.13"`).
  - API container base is **`oven/bun:1.3-alpine`** (latest 1.3.x) — `api/Dockerfile`.
- **API language: TypeScript ^5.6.0** — `api/package.json` (`devDependencies.typescript`). `tsconfig.json`: `target`/`module` `ESNext`, `moduleResolution: "bundler"`, `strict: true`, `types: ["bun-types"]`, `noEmit` (Bun runs `.ts` directly; no compile step).
- **Frontend language: JavaScript (ES modules).** No TypeScript, no `tsconfig` for the frontend.
- **Not found (confirmed absent):** `.nvmrc`, `.node-version`, `global.json`, any `*.csproj`. This is **not** a Node-version-pinned or .NET project.

⚠️ **Cannot verify / flag:** there is **no single Bun version pin** shared across local/CI/Docker — CI says `1.3.13`, Docker says `1.3` (floating). Local developers have no enforced version. Recommend a `.bun-version` or aligning all three.

---

## 2. Frameworks & major libraries

From the only manifest, **`api/package.json`** (dependencies):

| Library | Version | Role |
|---|---|---|
| `hono` | ^4.6.0 | HTTP framework for the API |
| `@supabase/supabase-js` | ^2.45.0 | DB / Auth / Storage client (PostgREST) — used in place of an ORM |
| `@anthropic-ai/sdk` | ^0.97.0 | Claude API (AI triage, draft replies, sentiment) |
| `zod` | ^3.23.0 | Request-body + env validation |
| `@types/bun` (dev) | ^1.1.10 | Bun type defs |
| `typescript` (dev) | ^5.6.0 | Typecheck only (`tsc --noEmit`) |

- **Frontend frameworks/libraries: none.** No React/Vue/Next/bundler. UI is vanilla ES modules under `js/` (single entry `js/app.js`), with its own conventions (a minimal `window` bridge, `data-action` event delegation) documented in `CLAUDE.md`.
- **Email:** Postmark, called via plain `fetch` (no SDK dependency).

---

## 3. Database, ORM, migration tool

- **Database:** PostgreSQL **17** (`supabase/config.toml` → `[db] major_version = 17`), hosted on **Supabase**.
- **ORM:** **None.** No Prisma schema, no Drizzle config — confirmed absent (the only deps are listed in §2). Tables/views/RPCs are reached through `@supabase/supabase-js` (PostgREST) and SQL functions.
- **Migrations:** **74** raw SQL files in `supabase/migrations/` (`20260520120000_extensions_and_helpers.sql` … `20260604130000_categories_admin_manageable.sql`), applied with the **Supabase CLI** (`supabase db push`). `CLAUDE.md` documents validating each on Docker PG 17 before pushing.
- **Connection strings / env samples:** the **API never uses a raw connection string** — it talks to Supabase over HTTPS using `SUPABASE_URL` + keys (see `api/src/lib/env.ts`, §7). The committed `api/.env.example` shows a **dev** project URL (`https://zpqapvffhakkbyadfcpr.supabase.co`).
- **Local Supabase config:** `supabase/config.toml` defines the local stack (API `54321`, DB `54322`, Studio `54323`, Inbucket `54324`, analytics `54327`) and Postgres 17.

⚠️ **Cannot verify / flag:**
- `[db.seed] sql_paths = ["./seed.sql"]` references **`supabase/seed.sql`, which does not exist** in the repo (demo data is a migration, `20260520121500_seed_demo.sql`). A `supabase db reset` would find no seed file.
- `config.toml` is mostly **default scaffold**: its `site_url` is `http://127.0.0.1:3000`, the **Custom Access Token Hook is commented out**, and `[edge_runtime]` (Deno 2) is enabled although **there are no edge functions** in the repo. `CLAUDE.md` explicitly warns **not** to `supabase config push` (it would clobber prod auth settings). The real hook + `site_url` are configured per-project out-of-band (dashboard / Management API), **not** from this file — an incoming engineer cannot infer prod auth state from the repo.

---

## 4. How the app runs: entry points, services, ports

Two independently-running pieces:

**API service** (`api/`):
- Entry: **`api/src/index.ts`** — a Hono app (`app.route('/api/v1/...')` for ~29 route modules in `api/src/routes/`) exported as Bun's default server: `export default { port, idleTimeout: 30, fetch: app.fetch }`.
- On boot it **starts two always-on background workers**: `startWebhookWorker` (outgoing-webhook delivery/retry) and `startCsatReminderWorker` (hourly CSAT re-send). Code comments note these assume a **single process** (no `FOR UPDATE SKIP LOCKED`), so the service must run as exactly one instance.
- Port: **3001** locally (`api/src/lib/env.ts` → `PORT` default 3001); **8080** in the container (see §5).
- Tests: `api/src/index.test.ts`, run with `bun test`.

**Frontend SPA** (repo root):
- Entry: **`index.html`** → `<script type="module" src="js/app.js">` (single module entry). An inline `<script>` at the top of `index.html` sets `window.MAESTRO_API_BASE` by hostname (localhost → `http://localhost:3001`; `desk`/`help.maestro-desk.com` → the deployed API).
- Customer portal: **`portal.html`** (self-contained, separate page).
- Local static server: **`scripts/serve-spa.js`** (`Bun.serve` on **port 5173**, serves the repo root so ES modules load).
- The SPA fetches `GET /api/v1/config` at runtime for the Supabase URL + anon key (route: `api/src/routes/config.ts`), so those are **not** baked into the frontend.

---

## 5. Containerization

- **`api/Dockerfile`** — base **`oven/bun:1.3-alpine`**; `bun install --frozen-lockfile --production`; **no build step** (`CMD ["bun", "src/index.ts"]`); `ENV PORT=8080`; `EXPOSE 8080`.
- **`api/fly.toml`** — Fly.io app **`maestro-desk-api`**, region `fra`, `internal_port = 8080`, `force_https = true`, **`auto_stop_machines = "off"`, `min_machines_running = 1`** (single always-on machine by design — see the workers in §4), VM `shared-cpu-1x` / `512mb`.
- **No `docker-compose`** file anywhere in the repo.
- **No frontend container** — the SPA is static files, not containerized.

---

## 6. Build & deploy

- **CI:** GitHub Actions — **`.github/workflows/ci.yml`** (`name: CI`), runs on every PR and on push to `main`. One job (`build + collision + smokes`): sets up Bun 1.3.13, then `bun build js/app.js`, a bridge-collision check, and two "smoke" scripts (every route renders; open every demo ticket). **There is no deploy step in CI** — deploys are manual/external.
- **Production build:** the frontend has **no production build** — `bun build` is used **only** to bundle for the CI smokes (`CLAUDE.md` is explicit: "no framework and no bundler in production"). `index.html` + `js/` ship as-is.
- **API deploy target:** Fly.io (`fly deploy`, per `api/fly.toml` and `PROD_SETUP.md`).
- **DB deploy:** `supabase db push` (CLI) against the hosted project.

⚠️ **Cannot verify / flag — frontend hosting:** `PROD_SETUP.md` states the SPA is served via **Cloudflare Pages** (`desk.`/`help.maestro-desk.com`), but **no Cloudflare config exists in the repo** (`wrangler.toml`, `_redirects`, `_headers` all absent) and **no `vercel.json` exists** either — yet a **Vercel integration is active on the GitHub repo** (it posts PR preview deployments). The production frontend host is therefore **ambiguous from the files alone**: confirm with the team whether prod is Cloudflare Pages, Vercel, or both.

---

## 7. Config & secrets

- **Schema + validation:** all env vars are declared and Zod-validated at boot in **`api/src/lib/env.ts`** (the process **exits on a missing/invalid var**). Sample committed at **`api/.env.example`**.
- **Required:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `POSTMARK_INBOUND_SECRET` (≥16 chars).
- **Optional (default `''`/skip):** `POSTMARK_SERVER_TOKEN`, `POSTMARK_OUTBOUND_FROM`, `POSTMARK_ACCOUNT_TOKEN`, `POSTMARK_INBOUND_REPLY_ADDRESS`, `PORTAL_BASE_URL`. `PORT` defaults to `3001`.
- **Secret manager:** in production, secrets are set via **`fly secrets set`** (documented in `PROD_SETUP.md`); locally they live in `api/.env` (gitignored — only `.env.example` is committed). No HashiCorp Vault / cloud secret-manager is used.
- **Frontend secrets:** none — it reads non-secret config (`supabase_url`, anon key) at runtime from `GET /api/v1/config`.

⚠️ **Cannot verify / flag:** real secret **values** are not in the repo (correct/expected). Project references are split across docs, not config: the dev project ref (`zpqapvffhakkbyadfcpr`) appears in `api/.env.example`; the prod ref is in `PROD_SETUP.md` only. The **Custom Access Token Hook must be enabled on the Supabase project** for RLS to return any rows (per `CLAUDE.md`/`PROD_SETUP.md`) — this is a non-obvious, out-of-band prerequisite that an engineer cannot discover from `config.toml` (where it is commented out).

---

## 8. Local run — start to finish

Prerequisites: **Bun** (≥1.3.x; CI uses 1.3.13), the **Supabase CLI** (for migrations), and **Docker** (for PG 17 migration validation, per `CLAUDE.md`). Access to a Supabase project + an Anthropic key.

**A. Backend API**
```sh
cd api
cp .env.example .env        # then fill in SUPABASE_*, ANTHROPIC_API_KEY, POSTMARK_INBOUND_SECRET
bun install
bun run dev                 # bun --hot src/index.ts  → http://localhost:3001
# health check:
curl http://localhost:3001/api/v1/health        # -> {"ok":true}
```

**B. Frontend SPA** (separate terminal)
```sh
bun scripts/serve-spa.js    # -> http://localhost:5173  (serves repo root)
```
Open `http://localhost:5173`. On `localhost` the SPA calls the API at `http://localhost:3001` automatically.

> Known gotcha (`CLAUDE.md` / project notes): if login shows **"failed to fetch"**, the **API on :3001 isn't running** — start step A first. The SPA has no backend of its own.

**C. Database / migrations** (only when changing schema)
```sh
# validate on Docker PG 17 first (see CLAUDE.md), then:
supabase db push --linked   # --dry-run first to confirm what's pending
```

**D. Typecheck / tests (API)**
```sh
cd api
bun run typecheck           # tsc --noEmit
bun test
```

---

## Quick reference — ports

| Service | Port | Source |
|---|---|---|
| API (local) | 3001 | `api/src/lib/env.ts` |
| API (container/Fly) | 8080 | `api/Dockerfile`, `api/fly.toml` |
| SPA dev server | 5173 | `scripts/serve-spa.js` |
| Supabase local stack (if `supabase start`) | 54321 (API) / 54322 (DB) / 54323 (Studio) / 54324 (Inbucket) | `supabase/config.toml` |

---

### Summary of everything flagged as unverifiable from files
1. No shared Bun version pin (CI 1.3.13 vs Docker `1.3` vs no local pin).
2. Production **frontend host is ambiguous** — `PROD_SETUP.md` says Cloudflare Pages; a Vercel integration is active on the repo; **no** Cloudflare/Vercel config file exists in-repo.
3. `config.toml` references a `seed.sql` that doesn't exist, and is otherwise default scaffold (hook commented out, `site_url` = localhost, edge-runtime enabled but no edge functions) — **real prod auth/hook state is configured out-of-band, not in the repo.**
4. Secret values and the prod project ref are not in committed config (by design); the Custom Access Token Hook is a required, out-of-band setup step not discoverable from `config.toml`.
