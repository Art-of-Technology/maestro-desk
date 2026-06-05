# Step 1 — Move the database to Neon (foundation)

**Branch:** `migrate/step-1-neon-database`
**Goal in one line:** Stand up Neon as the new database, get the schema and data into it, and give the code a clean way to run SQL against it — **without unplugging Supabase yet**, so the app keeps working.

---

## Decisions locked for this step
- **Postgres client:** `postgres` (porsager) — tagged-template SQL, no ORM.
- **Neon setup:** walk-through (project not created yet).
- **New migrations live in:** `db/migrations/` (old `supabase/migrations/` stays untouched for reference).

---

## In scope (this step)
- Create the Neon project + connection string.
- Add the `postgres` client and a small `db` helper to the API.
- Port **only the structural schema** to `db/migrations/`: tables, columns, indexes, functions, triggers, extensions.
- Copy existing data into Neon.
- Prove the API can read/write Neon via a health check.

## Out of scope (deliberately deferred — avoids breakage)
- **RLS policies, role grants, `authenticated`/`anon`/`service_role`** → handled in **Step 3** (security moves into API middleware).
- **`auth.users` / `auth.uid()` / the custom access token hook** → handled in **Step 2** (Better Auth owns users).
- **Rewriting the 28 files that query via the Supabase client** → rides along with **Step 3**.
- Supabase stays fully wired up this whole step. We are *adding* Neon alongside it, not removing anything.

---

## The checklist

### A. Set up Neon  *(your actions — I'll guide each one)*  ✅ DONE
- [x] Create a free Neon account and a new **project**.
- [x] Pick the region (eu-west-2 / London).
- [x] Copy the **connection string** (pooled, database `neondb`).
- [ ] *(optional, later)* Add a dedicated `dev` branch in Neon — currently pointed at the default branch. Fine for now.
- [x] Connection string stored in `api/.env` as `DATABASE_URL` (git-ignored, never committed).

### B. Wire up the client code  *(my actions)*  ✅ DONE
- [x] Add the `postgres` package to `api/package.json` (installed: `postgres@3.4.9`).
- [x] Add `DATABASE_URL` to `api/src/lib/env.ts` (optional for now) and to `.env.example`.
- [x] Create `api/src/lib/db.ts` — lazy, memoised `postgres` connection (SSL, small pool, `prepare:false` for Neon's pooler).
- [x] Create the migration runner (`api/scripts/migrate.ts`) + `bun run migrate` script.
- [x] **Proven against real Neon:** runner connects, created `schema_migrations`, `select version()` → PostgreSQL 18.4.
- [x] Safety: fixed `.gitignore` so `.env` files can never be committed.

### C. Port the structural schema  *(my actions)*  ✅ DONE
- [x] Create the `db/migrations/` folder.
- [x] Produce **Neon-compatible** schema: extensions (pgcrypto, citext), tables, indexes, helper + updated-at triggers, the `provision_brand`/`deduct_ai_credits` functions.
- [x] **Strip out** all RLS, policies, role grants, `auth.uid()`, the auth hook, and `storage.*`. (38 copied verbatim, 13 stripped, 22 omitted — see `db/migrations/README.md`.)
- [x] `users` table already exists structurally (with `password_hash`) — no placeholder needed; Better Auth reconciles in Step 2.
- [x] Applied all 52 migrations to Neon cleanly **from empty**. Verified: **53 tables, 0 with RLS**, custom functions present.

### D. Migrate the data  *(deliberately deferred — see rationale)*
- [~] **Deferred to when it's actually needed.** Nothing reads Neon until Step 3, so a data copy now would immediately go stale against the live Supabase DB. The demo **seed** already populates Neon (2 workspaces) — enough to build and test against.
- [ ] *(Later)* Dump live Supabase data (`pg_dump --data-only`) → load into Neon → verify row counts, done right before Step 3 routes start reading Neon (final fresh copy at cutover).

### E. Prove it works  *(my actions)*  ✅ DONE
- [x] Added `GET /api/v1/health/ready/neon` — runs raw SQL against Neon (leaves the existing Supabase `/ready` untouched).
- [x] Booted the API locally and hit it: `{"ok":true,"db":"neon","workspaces":2}`.
- [x] `bun run typecheck` green.

### F. Wrap up the branch
- [ ] Commit in small, labelled chunks.
- [ ] Open a PR titled `Step 1: stand up Neon database (foundation)`.
- [ ] PR description lists exactly what's deferred to Steps 2–3 so reviewers don't expect the query rewrite here.
- [ ] **Do not merge** until the health check is green and data counts are verified.

---

## Open questions / risks (worth a quick decision before/while we build)
1. **Placeholder users table.** The schema references a users table that today lives in Supabase auth. For Step 1 we either (a) create a minimal placeholder so foreign keys work and let Better Auth replace it in Step 2, or (b) port users-with-data now and adapt in Step 2. I lean (a) — cleaner. Confirm when we get there.
2. **Data freshness.** The data copy is a point-in-time snapshot. If the live app keeps changing data during the migration, we'll do a final fresh copy right before the real cutover (much later). For now, a snapshot for dev is fine.
3. **Extensions.** Neon supports `pgcrypto` and `citext` — no action needed, just confirming.
4. **No production cutover in this step.** Production keeps running on Supabase/current host until later steps are done and verified.

---

*Status: checklist ready. Next action: Section A — set up the Neon project (I'll walk you through it).*
