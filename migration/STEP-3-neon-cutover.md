# Step 3 — Security → API middleware + cutover to Neon / Better Auth

**Branch:** `migrate/step-3-neon-cutover` (created off `main` once Step 2 / PR #300 merges)
**Goal in one line:** Move every route off the Supabase client onto **raw SQL on Neon** with **per-route authorization**, then flip login to **Better Auth** — ending Supabase's role entirely.

This is the largest, highest-care step. It absorbs the original Step 2 cutover (C/D/E) and the bulk data copy deferred from Step 1.

---

## Decisions — LOCKED ✅
1. **Sequencing → incremental, auth-flip last.** Rewrite routes to Neon family-by-family (small PRs) while login stays on Supabase JWT. Flip the login token to Better Auth in a final PR, once nothing reads Supabase.
2. **Data copy → one upfront full copy + final resync.** Copy all Supabase data → Neon at the start (so rewritten routes have real data), then a fresh resync right before the auth flip / go-live.

## Why this is safe to do incrementally
A route rewritten to query Neon uses its existing `.eq('workspace_id', workspaceId)` scoping plus the middleware's membership check — it no longer needs the Supabase JWT/RLS. So routes can move one family at a time while login still runs on Supabase. RLS is replaced by explicit API checks as each family moves; the token flip is the very last thing.

---

## Sub-PRs (incremental)

### PR 3.0 — Full data copy + access/authz foundation
- [x] **Data copy DONE.** `api/scripts/copy-from-supabase.ts` — copies all 52 data tables Supabase→Neon. `pg_dump` isn't available locally, so it's a programmatic copy: FK-topological order on NOT-NULL edges; nullable FK columns deferred (nulled on insert, patched after all loads) to break self-refs (`tickets`) and cross-table cycles (`tickets`↔`inbox_messages`); copies only columns common to both DBs; truncates seed first. Verified: all 52 tables match row counts; deferred FKs round-trip (customer_id 20/20, assigned_user_id 6/6, ai_usage_log.ticket_id 19). Reusable for the final resync.
- [x] **Data-access pattern established** (PR 3.1): raw tagged-template SQL via `getDb()`, inline in the route. Shared helpers to emerge as repetition shows up.
- [x] **Authz helper established** (PR 3.1): `api/src/lib/authz.ts` → `requireWorkspaceAdmin(c)` checks the caller's role `is_admin` in Neon, with the platform-admin escape hatch. Replaces the `is_workspace_admin` RPC + admin-write RLS policies. (`requireWorkspaceMember` stays in `middleware/auth.ts`.)
- [x] Proven: reads through `getDb()` return copied demo data.

### PR 3.1 — Template route: **categories** → Neon  ✅ DONE
*(Switched from tickets: tickets is entangled with 7 Supabase-backed lib modules, a poor first template. categories is self-contained AND exercises member-read + admin-write — ideal for establishing the pattern. tickets moves later, with its libs, as its own PR.)*
- [x] Rewrote `routes/categories.ts` from `sbUser` + `is_workspace_admin` RPC → raw SQL on Neon + `requireWorkspaceAdmin`.
- [x] Verified end-to-end vs Neon: GET (member list), POST (admin create + 409 duplicate), PATCH (admin enable/disable); authz allows admin, denies read-only.

### PR 3.x — tickets → Neon (its own PR, with lib deps)
- [ ] Rewrite `routes/tickets.ts` **and its 7 lib deps** (`workflow-engine`, `assign-rules-engine`, `slack-notify`, `outgoing-webhooks`, `sentiment`, `csat-survey`, `mention-notify`) together, so the ticket feature moves to Neon as one coherent unit (no split-brain).
- [ ] Verify list/detail/create/update/merge/snooze/time against copied data.

### PR 3.2 … 3.n — Remaining families → Neon (one PR each, or grouped)
Route families to migrate (each still authenticates via Supabase JWT until the final flip):
- [x] customers (bounce state)  *(Batch C)*
- [x] channels + inbox (incl. transactional convert)  *(Batch C)*
- [x] kb (+ votes, atomic view counter)  *(Batch C)*
- [x] canned-responses, ticket-templates  *(Batch A)*
- [x] custom-fields + custom-values  *(Batch A)*
- [x] agents (admin-write authz), roles (member-level), permissions  *(Batch D)*
- [x] workflows, sla-policies, assign-rules  *(Batch B)*
- [x] **categories** (PR 3.1, admin-write authz) · **saved-searches** (owner-only write + own/shared read authz)
- [x] tags  *(Batch B — incl. the merge endpoint)*
- [x] integrations (slack/stripe/shopify + outgoing webhooks + postmark suppression)  *(Batch E)*
- [x] presence (generic presence table)  *(Batch D)*
- [x] me  *(Batch D)*  ·  [ ] workspace (still pending)
- [ ] god routes (platform-admin; provisioning via `provision_brand` fn already on Neon)
- [ ] portal (public): `lib/portal-auth.ts` + `routes/public.ts` — move its DB calls (magic links / sessions) to Neon. (Self-contained token auth, unchanged logic.)
- [ ] lib data-access modules still on `supabaseAdmin` (inbound-email, csat-survey, workflow-engine, mention-notify, outgoing-webhooks worker, postmark-*, etc.)

### PR 3.final — Flip login to Better Auth + retire Supabase
- [ ] Fresh data resync Supabase → Neon (catch up anything changed since 3.0).
- [ ] `middleware/auth.ts` + `middleware/platform-admin.ts`: verify the Better Auth session (`auth.api.getSession`) instead of `supabaseAdmin.auth.getUser`; drop `sbUser`/`userClient`.
- [ ] `whoami.ts`: read identity + memberships from Neon (already Neon-backed if migrated earlier).
- [ ] `routes/config.ts`: serve Better Auth base path, stop shipping `supabase_url`/`anon_key`.
- [ ] `routes/god.ts`: brand-owner invite via Better Auth instead of `auth.admin.generateLink`.
- [ ] `js/core/auth-client.js`: sign in via Better Auth; keep the Bearer + sessionStorage pattern.
- [ ] Re-invite/reset emails so agents set Better Auth passwords (the locked Step 2 decision).
- [ ] Set `BETTER_AUTH_SECRET` (+ `DATABASE_URL`) in the real runtime env; flip both to **required** in `env.ts`.
- [ ] Harden the Better Auth `pg` Pool for prod (carried over from #300 review): explicit `ssl` and a `max` connection cap, matching `lib/db.ts` (`max: 5`). Dormant until now, so deferred to here.
- [ ] Remove `@supabase/supabase-js`, `lib/supabase.ts`, and the `SUPABASE_*` env vars once nothing imports them.

---

## Risks / notes
- **One family at a time, verify each.** Each PR through `/cem-pr-loop` to 4+/5.
- **Authz parity:** for every RLS policy removed, confirm an equivalent API check exists (membership + admin-write + platform-admin). This is where mistakes are invisible — review carefully.
- **Data copy is point-in-time** until the final resync; the live app keeps writing to Supabase until the flip.
- **The token flip is the only hard cutover** — everything before it is reversible per-family.

---
*Status: planned, decisions locked. Branch + this file land once PR #300 (Step 2) merges.*
