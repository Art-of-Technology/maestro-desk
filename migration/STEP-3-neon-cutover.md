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
- [ ] One-time data migration script: `pg_dump --data-only` from Supabase → load into Neon (preserve ids; respect FK order; the schema is already there from Step 1). Verify row counts per table.
- [ ] Establish the **data-access pattern**: raw tagged-template SQL via `getDb()` (from Step 1's `lib/db.ts`). Inline `sql\`…\`` in routes; add small shared helpers only for repeated shapes (workspace-scoped list/get/insert/update/soft-delete).
- [ ] Establish **authz helpers** (replacing RLS policies):
  - `requireWorkspaceMember` — already in `middleware/auth.ts` (membership verified). Keep.
  - `requireWorkspaceAdmin(workspaceId)` — new: checks the caller's role `is_admin` in Neon. Replaces the admin-only RLS policies (`workspace_members` writes, `categories` writes).
  - platform-admin escape hatch — already in middleware (`is_platform_admin`). Keep.
- [ ] Prove: a read path through `getDb()` returns copied data for the demo workspace.

### PR 3.1 — First route family (tickets) → Neon  *(establishes the template)*
- [ ] Rewrite `routes/tickets.ts` + its lib deps (`triage.ts`, `auto-reply.ts`, sentiment, etc. as needed) from `sbUser`/`supabaseAdmin` to raw SQL on Neon.
- [ ] Apply authz helpers where the ticket RLS policies enforced rules.
- [ ] Verify against copied data (list, detail, create, update, assignment).

### PR 3.2 … 3.n — Remaining families → Neon (one PR each, or grouped)
Route families to migrate (each still authenticates via Supabase JWT until the final flip):
- [ ] customers (+ customer notes, bounce state)
- [ ] channels + inbox
- [ ] kb (+ votes)
- [ ] canned-responses, ticket-templates
- [ ] custom-fields + custom-values
- [ ] agents, roles, permissions (admin-write authz)
- [ ] workflows, sla-policies, assign-rules
- [ ] saved-searches, tags, categories (admin-write authz)
- [ ] integrations (slack/stripe/shopify) + outgoing webhooks (the `sb` routes)
- [ ] presence (generic presence table)
- [ ] me, workspace
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
