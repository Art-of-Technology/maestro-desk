# Maestro Desk — Engineering Setup Overview

> Audience: a new engineer (and the CTO). Every claim below is taken from the actual files in this repo; file paths are cited inline. Anything that could **not** be verified from the files is called out under **⚠️ Cannot verify from files**.
>
> **State:** the Supabase→Neon migration has landed in code — the API talks to Neon directly and uses Better Auth, with no Supabase SDK remaining. A few **legacy Supabase/Fly.io artefacts** are still in the tree (see §9); they are being removed and are flagged where they appear.

---

## 0. Expectation vs. reality (read this first)

The stack was expected to be *Bun, TypeScript, Next.js, Prisma/Drizzle, Postgres, a Next.js app framework, and a Hono API*. Here is what the files actually show:

| Expected | Reality | Verdict |
|---|---|---|
| **Bun** | Bun runs the API locally and all tooling (build, smokes, static server). | ✅ Correct |
| **TypeScript** | API only (`api/`, TS 5.6). **The frontend is plain JavaScript ES modules** (`js/`), not TypeScript. | ⚠️ Half right — backend only |
| **Next.js** | **Not present.** No Next.js, no React, no framework, no bundler in production. The frontend is a hand-written vanilla-JS ES-module SPA served as a static `index.html`. | ❌ Wrong |
| **Prisma / Drizzle** | **Neither.** No ORM at all. Data access is the raw **`postgres`** client against Neon; migrations are plain `.sql` files. | ❌ Wrong |
| **Postgres** | Yes — **Neon** serverless Postgres (was Supabase-hosted PG 17 pre-migration). | ✅ Correct (host changed) |
| **Next.js app framework** | Same as above — no framework. | ❌ Wrong |
| **Hono API** | Yes — Hono 4.6 on Bun, exported for the **Vercel** serverless adapter. | ✅ Correct |

**The two big surprises for an incoming engineer:** there is **no Next.js / React** (the UI is framework-less vanilla JS), and **no ORM** (raw `postgres`/`pg` clients + SQL migrations). The only `package.json` in the repo is `api/package.json` — the frontend has no package manifest, no dependencies, and no build step in production.

**Approved stack (per `~/.claude/CLAUDE.md` guardrails):** Vercel (hosting, frontend + API), Neon (DB), Better Auth (auth), Cloudflare R2 (storage), Pubby (realtime), Vercel Cron (jobs), Bun + Hono, raw-SQL migrations, no ORM. Supabase and Fly.io are explicitly **out** — any references to them in the tree are legacy.

---

## 1. Language & runtime (with versions)

- **Runtime: Bun** (local + CI). No single pinned version file shared across all contexts:
  - CI pins **Bun 1.3.13** — `.github/workflows/ci.yml` (`oven-sh/setup-bun@v2`).
  - The legacy `api/Dockerfile` base is **`oven/bun:1.3-alpine`** (floating 1.3.x).
- **API language: TypeScript ^5.6.0** — `api/package.json`. `tsconfig.json`: `ESNext` target/module, `moduleResolution: "bundler"`, `strict: true`, `types: ["bun-types"]`, `noEmit` (Bun runs `.ts` directly; no compile step).
- **Frontend language: JavaScript (ES modules).** No TypeScript, no `tsconfig` for the frontend.
- **Not found (confirmed absent):** `.nvmrc`, `.node-version`, `global.json`, any `*.csproj`. This is **not** a Node-version-pinned or .NET project.

⚠️ **Cannot verify / flag:** there is **no single Bun version pin** shared across local/CI/Docker — CI says `1.3.13`, the legacy Dockerfile says `1.3` (floating). Local developers have no enforced version. On **Vercel** the Node/Bun runtime is set by the platform, not by these files. Recommend a `.bun-version` if local pinning matters.

---

## 2. Frameworks & major libraries

From the only manifest, **`api/package.json`** (dependencies):

| Library | Version | Role |
|---|---|---|
| `hono` | ^4.6.0 | HTTP framework for the API |
| `postgres` | ^3.4.5 | Neon Postgres client for all app routes (raw SQL) — `api/src/lib/db.ts` |
| `pg` | ^8.21.0 | node-postgres pool used by Better Auth — `api/src/lib/auth.ts` |
| `better-auth` | ^1.6.14 | Live auth system (sessions/users/sign-in), owns its tables in Neon |
| `@getpubby/sdk` | ^0.2.0 | Pubby realtime (Pusher-compatible push for live ticket updates) |
| `aws4fetch` | ^1.0.20 | S3-style request signing for Cloudflare R2 (no AWS SDK) |
| `@vercel/functions` | ^3.6.3 | Vercel serverless helpers (e.g. `waitUntil` for inline async work) |
| `@anthropic-ai/sdk` | ^0.97.0 | Claude API (AI triage, draft replies, sentiment) |
| `zod` | ^3.23.0 | Request-body + env validation |
| `@types/bun` (dev) | — | Bun type defs |
| `typescript` (dev) | ^5.6.0 | Typecheck only (`tsc --noEmit`) |

- **`@supabase/supabase-js`: absent.** No Supabase SDK and no `supabaseAdmin` client anywhere in `api/src/` — confirmed removed by the migration.
- **Frontend frameworks/libraries: none.** No React/Vue/Next/bundler. UI is vanilla ES modules under `js/` (single entry `js/app.js`), with its own conventions (a minimal `window` bridge, `data-action` event delegation) documented in `CLAUDE.md`.
- **Email:** Postmark, called via plain `fetch` (no SDK dependency).

---

## 3. Database, auth, ORM, migration tool

- **Database:** **Neon** serverless Postgres — the source of truth. Connection via `DATABASE_URL` (required at boot — `api/src/lib/env.ts:8`). The client is **`postgres`** (porsager), lazily initialised in **`api/src/lib/db.ts`** with `ssl: 'require'`, a small pool (`max: 5`), and **`prepare: false`** (Neon's pooler doesn't support prepared statements).
- **Auth:** **Better Auth** (`api/src/lib/auth.ts`) — the live auth system. It uses its **own `pg` Pool** (separate from the app's `postgres` client, reused across hot-reloads) and signs sessions with `BETTER_AUTH_SECRET` (required, ≥32 chars). Bearer-token transport (`bearer()` plugin). Its tables (`session`, `account`, `verification`) plus added columns on the existing `users` table were created in `db/migrations/20260605120000_better_auth.sql`. **Better Auth replaces Supabase Auth** — do not reference `auth.users`.
- **ORM:** **None.** No Prisma/Drizzle/Kysely. Tables are reached with raw SQL through the `postgres`/`pg` clients.
- **Migrations:** raw `.sql` files. **Canon is `db/migrations/` (53 files)** — the Neon migration set, applied to Neon. The old **`supabase/migrations/` (74 files)** is retained for reference only and is **not** applied. New schema changes go in new timestamped files under `db/migrations/`.
- **Authorization:** moved from Supabase **RLS to per-route API middleware** in the Hono app (security checks live in middleware, not the database). The Neon migrations do not carry the old RLS policies.

⚠️ **Cannot verify / flag:**
- `supabase/config.toml` still exists but is **inactive legacy** — it describes the old local Supabase emulator (ports `54321`–`54327`, PG 17). It is not part of the current dev workflow and would clobber nothing because nothing reads it now.
- Local schema validation is done by spinning up **Docker Postgres 17** and applying `db/migrations/` (per `CLAUDE.md`), not the Supabase CLI.

---

## 4. How the app runs: entry points, services, ports

Two independently-running pieces:

**API service** (`api/`):
- **Production entry: `api/src/index.ts`** — a Hono app mounting ~30 route modules under `/api/v1/...` (`api/src/routes/`) and Better Auth under `/api/auth/*`. It is **exported as the default Hono app** (`export default app`) so the **Vercel** serverless adapter (`@vercel/functions`) can wrap it — there is no `Bun.serve` here.
- **Local entry: `api/src/dev.ts`** — the Bun dev server. It also **starts two in-process background workers**: `startWebhookWorker` (outgoing-webhook delivery/retry) and `startCsatReminderWorker` (hourly CSAT re-send). These assume a **single process** (no `FOR UPDATE SKIP LOCKED`), so they run locally only.
- **In production these workers are replaced by Vercel Cron** (see §6) hitting `/api/v1/cron/*`; inline async work uses `waitUntil` from `@vercel/functions`.
- Port: **3001** locally (`api/src/lib/env.ts` → `PORT` default 3001).
- Tests: `api/src/index.test.ts`, run with `bun test`.

**Frontend SPA** (repo root):
- Entry: **`index.html`** → `<script type="module" src="js/app.js">` (single module entry). An inline `<script>` at the top of `index.html` sets `window.MAESTRO_API_BASE` by hostname (see §9).
- Customer portal: **`portal.html`** (self-contained, separate page).
- Local static server: **`scripts/serve-spa.js`** (`Bun.serve` on **port 5173**, serves the repo root so ES modules load).
- **There is no `GET /api/v1/config` route.** (The pre-migration doc claimed one returning a Supabase URL + anon key — that no longer exists.) The SPA learns its API base from the inline script in `index.html`; Pubby's client config is served separately at `GET /api/v1/pubby/config`.

---

## 5. Containerization

- **`api/Dockerfile`** — **legacy** (built for the Fly.io path). Base `oven/bun:1.3-alpine`; `bun install --frozen-lockfile --production`; **no build step**; `CMD ["bun", "src/index.ts"]`; `EXPOSE 8080`. On Vercel the platform builds and invokes the serverless function instead — this Dockerfile is not the production path under the approved stack.
- **No `docker-compose`** file anywhere in the repo. Docker is used locally only for Postgres 17 migration validation (§3).
- **No frontend container** — the SPA is static files, served as-is.

⚠️ **Flag:** `api/Dockerfile` and `api/fly.toml` (§9) exist but target **Fly.io**, which the project guardrails explicitly reject. They are migration leftovers; production runs on Vercel.

---

## 6. Build & deploy

- **CI:** GitHub Actions — **`.github/workflows/ci.yml`** (`name: CI`), runs on every PR and on push to `main`. One job: sets up Bun 1.3.13, then `bun build js/app.js`, a bridge-collision check, and two "smoke" scripts (every route renders; open every demo ticket). **There is no deploy step in CI** — deploys are external.
- **Production build:** the frontend has **no production build** — `bun build` is used **only** to bundle for the CI smokes (`CLAUDE.md`: "no framework and no bundler in production"). `index.html` + `js/` ship as-is.
- **Hosting target: Vercel** (per project guardrails). The frontend deploys as static files; the **Hono API deploys as a serverless function** via the Vercel adapter (the routes themselves are unchanged). A Vercel integration is active on the GitHub repo (it posts PR preview deployments).
- **Scheduled jobs: Vercel Cron** — declared in **`api/vercel.json`**: `0 3 * * *` → `/api/v1/cron/webhook-retry`, and `0 4 * * *` → `/api/v1/cron/csat-reminders`. These call the cron endpoints (guarded by `CRON_SECRET`) that, in production, do the sweeping the in-process dev workers do locally.
- **DB deploy:** apply `db/migrations/` SQL to Neon (validate on Docker PG 17 first, per `CLAUDE.md`).

⚠️ **Cannot verify / flag — production cutover:** `index.html` still maps the prod hostnames to a **Fly.io** API URL (§9), and `api/fly.toml`/`api/Dockerfile` still exist. These contradict the approved **Vercel-only** stack and are migration leftovers slated for removal. Confirm with the team that the frontend's API base and any DNS/host config have been repointed to the Vercel deployment.

---

## 7. Config & secrets

- **Schema + validation:** all env vars are declared and Zod-validated at boot in **`api/src/lib/env.ts`** (the process **exits on a missing/invalid var**). Sample committed at **`api/.env.example`**.
- **Required (no default in the schema):**
  - `DATABASE_URL` — Neon connection string (`api/src/lib/env.ts:8`).
  - `BETTER_AUTH_SECRET` — session signing key, ≥32 chars (`:17`).
  - `ANTHROPIC_API_KEY` — ≥20 chars (`:24`).
  - `POSTMARK_INBOUND_SECRET` — inbound webhook secret, ≥16 chars (`:28`).
- **Optional (default `''`/skip or platform-set):** `BETTER_AUTH_URL`, `APP_BASE_URL`, `POSTMARK_SERVER_TOKEN`, `POSTMARK_OUTBOUND_FROM`, `POSTMARK_ACCOUNT_TOKEN`, `POSTMARK_INBOUND_REPLY_ADDRESS`, `PORTAL_BASE_URL`, the `R2_*` group (Cloudflare R2 brand-asset uploads), the `PUBBY_*` group (realtime; unset → SPA falls back to polling), `CRON_SECRET` (required on Vercel, optional locally), and `PORT` (default 3001).
- **No `SUPABASE_*` vars** are read anymore — the loader has none.
- **Secret manager:** in production, secrets are set in **Vercel project env vars**; locally they live in `api/.env` (gitignored — only `.env.example` is committed). No HashiCorp Vault / cloud secret-manager.
- **Frontend secrets:** none — it only needs the API base URL (set inline in `index.html`).

⚠️ **Cannot verify / flag:** real secret **values** are not in the repo (correct/expected). Some legacy docs (`api/fly.toml` comments, `PROD_SETUP.md`) still list `SUPABASE_*`/`fly secrets set` — treat those as stale; the live required set is the four vars above.

---

## 8. Local run — start to finish

Prerequisites: **Bun** (≥1.3.x; CI uses 1.3.13) and **Docker** (for PG 17 migration validation, per `CLAUDE.md`). Access to a Neon database (or local Docker PG) + an Anthropic key.

**A. Backend API**
```sh
cd api
cp .env.example .env        # then fill: DATABASE_URL, BETTER_AUTH_SECRET, ANTHROPIC_API_KEY, POSTMARK_INBOUND_SECRET
bun install
bun run dev                 # bun --hot src/dev.ts  → http://localhost:3001
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
# validate each new db/migrations/*.sql on Docker PG 17 first (see CLAUDE.md), then
# apply to Neon (psql against DATABASE_URL, or the team's apply script).
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
| API (local) | 3001 | `api/src/lib/env.ts` (`PORT` default) |
| API (legacy container) | 8080 | `api/Dockerfile` (`EXPOSE 8080`) — Fly path, being retired |
| SPA dev server | 5173 | `scripts/serve-spa.js` |
| Docker PG 17 (migration validation) | 5432 (typical) | local Docker; see `CLAUDE.md` |

---

### Summary of everything flagged as unverifiable / in-flight from files
1. **No shared Bun version pin** (CI `1.3.13` vs legacy Dockerfile `1.3` vs no local pin; Vercel sets its own runtime).
2. **Fly.io leftovers contradict the Vercel-only stack:** `index.html` still points prod at `maestro-desk-api.fly.dev` (§9), and `api/fly.toml` + `api/Dockerfile` still exist. Confirm the frontend API base and host config are repointed to Vercel; these files are slated for removal.
3. **`supabase/` is legacy:** `supabase/config.toml` and `supabase/migrations/` (74 files) are retained for reference only — the live migration set is `db/migrations/` (53 files) applied to Neon.
4. **Secret values and prod connection details** are not in committed config (by design); some stale docs still mention `SUPABASE_*` / `fly secrets` — the live required set is `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY`, `POSTMARK_INBOUND_SECRET`.
5. **Background-worker model differs by environment:** in-process workers run only via `api/src/dev.ts` locally; production relies on **Vercel Cron** (`api/vercel.json`) hitting `/api/v1/cron/*`.

---

## 9. Known legacy artefacts (being removed)

These remain in the tree but contradict the approved stack — do not build on them:

- **`api/fly.toml`** — Fly.io app config (`maestro-desk-api`, region `fra`, always-on machine). Fly.io is explicitly rejected by the guardrails; this file is being deleted. Do not re-add or reference it.
- **`api/Dockerfile`** — built for the Fly path (§5). Not the Vercel production path.
- **`index.html` API-base mapping** — the inline script maps `desk.maestro-desk.com` / `help.maestro-desk.com` → `https://maestro-desk-api.fly.dev`. This still points at Fly and must be repointed to the Vercel API host as part of finishing the cutover.
- **`supabase/`** — `config.toml` + 74 reference migrations from the Supabase era; superseded by `db/migrations/` on Neon.
