# CLAUDE.md — maestro-desk

Guidance for Claude Code working in this repo. (The user's global `~/.claude/CLAUDE.md` still applies; this file takes precedence for project-specific guidance.)

## What this is

A static SPA — vanilla JS ES modules, **no framework and no bundler in production**. The frontend lives under **`web/`** (the SPA's Vercel project Root Directory); `web/index.html` is served as-is and loads a single module entry, `web/js/app.js`, via `<script type="module">`. `bun build` is used **only** for the CI smokes, never to produce a shipped artifact. Backend API lives under `api/` (Bun on :3001). iGaming, AI-native helpdesk (a Zoho Desk rival).

> **Repo layout:** frontend = `web/` (index.html, portal.html, js/, styles/); backend = `api/`. The two are separate Vercel projects with non-overlapping Root Directories (`web` and `api`), so neither builds the other. Served paths are unchanged (`web/` is the SPA's served root, so `web/js/app.js` → `/js/app.js`).

## Architecture (post routing/global-coupling cleanup — PRs #281–#286)

The codebase finished migrating off two pieces of implicit global coupling. The current shape:

- **Single module entry.** `index.html` loads only `web/js/app.js` as a module. There are no classic `<script src>` tags for app code — `web/js/core/state.js` and `web/js/core/data.js` are ES modules pulled in through `app.js`'s import graph.

- **Routing lives in `web/js/core/router.js`** — `nav`, `renderPage`, `updateNavBadges`, and the page registry. Every caller imports them directly; **they are not on the window bridge.** `app.js` is bootstrap-only (login/logout, workspace brand, layout hydration, startup, the bridge).

- **The window bridge is minimal.** `app.js` re-exposes only app-wide utilities — `login`, `logout`, `applyWorkspaceBrand`, `resetWorkspaceBrand`, `fmtMinutes`, `escHtml`, `escAttr`, `isAdmin`, `setSettingsTab`. **No feature-module namespaces.** (`escHtml`/`escAttr`/`isAdmin`/`fmtMinutes` are app.js-local and can't be imported, so module code reaches them by bare name through the bridge until a `core/dom.js` extraction.)

- **Shared state is import-based.** `web/js/core/state.js` (UI state) and `web/js/core/data.js` (seed/live data) export every binding. Importers read them **live** (an imported binding reflects the latest value). Because an imported binding can't be reassigned by the importer:
  - **Mutable scalars** are written through a per-name setter — `setX(v)` (46 in state.js; `setPermissions` is the only one in data.js).
  - **Const collections** (Sets, arrays, the `ASSIGN_RULES_RR_INDEX` object) are mutated **in place** (`.add`/`.clear`/`.push`/`.splice`/`obj[k]=`) and need no setter. `bootstrap.js` swaps live API data in via `target.length = 0; target.push(...)`, preserving array identity so importers see new contents.
  - Setter naming: `setCamelCase`; add a `Value` suffix only to dodge a collision with an existing feature function (`setComposeTabValue`, `setSettingsTabValue`).

- **Events use data-action delegation.** Inline `on*=` handlers were migrated to `data-action="ns.fn"` dispatched through `web/js/core/event-delegation.js`. Cross-module calls are direct ES imports.

## CI gates — run before pushing (`.github/workflows/ci.yml` runs them on every PR)

```bash
bun build web/js/app.js > scripts/app.bundled.js          # 1. build
bun scripts/bridge-collision-check.mjs                    # 2. no duplicate bridge exports
# 3. route smoke — every route renders:
bun build scripts/route-smoke-entry.js > scripts/route-entry.bundled.js
cat scripts/bridge-smoke-shim-prefix.js scripts/route-entry.bundled.js scripts/bridge-smoke-shim-suffix.js > scripts/full-smoke.js
bun scripts/full-smoke.js
# 4. detail smoke — openTicket every demo ticket:
bun build scripts/detail-smoke-entry.js > scripts/detail-entry.bundled.js
cat scripts/bridge-smoke-shim-prefix.js scripts/detail-entry.bundled.js scripts/detail-smoke-suffix.js > scripts/detail-smoke.js
bun scripts/detail-smoke.js
```

## Gotchas / safety nets

- **The smokes bundle everything into one scope**, so a *missing cross-module import* still resolves there (bare ref → bundle top-level var) and neither `bun build` nor the smokes will catch it. **Production is native ESM**, where the same bare ref throws `ReferenceError`. After any import-migration work, verify import-completeness with a **static audit** (comment-stripped scan; path-flexible — `core/` files import `./state.js`, others `../core/state.js`; spread-aware so `[...FOO]` counts as a read).
- **Adding a state/data global:** export it; add a `setX` setter only if it's *reassigned* anywhere (in-place mutation needs none); every consuming module must import it.
- Bundling regex/script tip: `git ls-files web/js` (not a `**` pathspec); use `String.raw` for regex in scripts (template literals eat `\w`/`\b`); files are CRLF — make literal-replacement scripts EOL-aware.

## Database (Neon)

The database is **Neon Postgres**, accessed directly via `postgres.js` (`getDb()` in `api/src/lib/db.js`) — no ORM. Supabase has been fully retired; ignore any lingering Supabase references in old code comments.

- **Migrations are raw SQL** in `db/migrations/` (repo root), applied in filename order. Add changes as a **new timestamped file** (`YYYYMMDDHHMMSS_description.sql`) — never edit an already-applied one. `api/scripts/migrate.ts` (`bun run migrate`) tracks applied files in `schema_migrations` so re-runs skip them; the deploy-time GitHub Action runs it on push to `main`.
- **Authorization is API middleware, not RLS.** There is no row-level security anymore: every route filters by `workspace_id` and uses `requireAuth` / `requireWorkspaceAdmin` (`api/src/lib/authz.ts`). A new route that touches workspace-scoped tables **must** include the `where workspace_id = …` predicate — there is no database backstop.
- **`citext`** backs `users.email` / `customers.email`; keep it in `public` (a `search_path` lacking it silently degrades comparisons to case-sensitive).
- **Validate new migrations on Docker PG 17** (`docker run postgres:17` + per-file `psql` apply) before pushing.

## Workflow

**Mandatory gates — every change passes these in order (don't skip ahead):**

1. **Plan first.** Write an implementation plan before any edit; use plan mode (`EnterPlanMode`) for non-trivial work. No edits before a plan exists.
2. **Validate the plan (twice).** Re-check the plan yourself first (adversarial pass: wrong assumptions, missing steps, simpler approach, blast radius), then get the requester's approval (`ExitPlanMode`). Execute only after approval.
3. **Execute the approved plan.** If reality diverges mid-flight, stop, re-plan, and get approval again.
4. **Validate the code before the PR.** Before `gh pr create`: run the CI gates above (build + bridge-collision + route smoke + detail smoke) **and** the import-completeness static audit (the smokes don't catch missing imports — see Gotchas), then run `/code-review` and resolve its findings. (On Jodi's machine a `PreToolUse` hook also forces this checkpoint.)

> *Note: `EnterPlanMode` / `ExitPlanMode` / `PreToolUse` are Claude Code tooling references. The gates apply to any contributor regardless of tooling — for humans, "plan" = a written plan in the PR/issue and "validate the plan" = reviewer sign-off before implementation.*

**Branching & review.** Feature branch per change (`feat/…`, `fix/…`), PR, then `/cem-pr-loop` (Octopus review) to a 4+/5 score before merge. When merging a stack, don't `--delete-branch` a PR that's still the base of another open PR (it auto-closes the child) — retarget children to `main` first.
