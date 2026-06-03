# CLAUDE.md — maestro-desk

Guidance for Claude Code working in this repo. (The user's global `~/.claude/CLAUDE.md` still applies; this file takes precedence for project-specific guidance.)

## What this is

A static SPA — vanilla JS ES modules, **no framework and no bundler in production**. `index.html` is served as-is and loads a single module entry, `js/app.js`, via `<script type="module">`. `bun build` is used **only** for the CI smokes, never to produce a shipped artifact. Backend API lives under `api/` (Bun on :3001). iGaming, AI-native helpdesk (a Zoho Desk rival).

## Architecture (post routing/global-coupling cleanup — PRs #281–#286)

The codebase finished migrating off two pieces of implicit global coupling. The current shape:

- **Single module entry.** `index.html` loads only `js/app.js` as a module. There are no classic `<script src>` tags for app code — `js/core/state.js` and `js/core/data.js` are ES modules pulled in through `app.js`'s import graph.

- **Routing lives in `js/core/router.js`** — `nav`, `renderPage`, `updateNavBadges`, and the page registry. Every caller imports them directly; **they are not on the window bridge.** `app.js` is bootstrap-only (login/logout, workspace brand, layout hydration, startup, the bridge).

- **The window bridge is minimal.** `app.js` re-exposes only app-wide utilities — `login`, `logout`, `applyWorkspaceBrand`, `resetWorkspaceBrand`, `fmtMinutes`, `escHtml`, `escAttr`, `isAdmin`, `setSettingsTab`. **No feature-module namespaces.** (`escHtml`/`escAttr`/`isAdmin`/`fmtMinutes` are app.js-local and can't be imported, so module code reaches them by bare name through the bridge until a `core/dom.js` extraction.)

- **Shared state is import-based.** `js/core/state.js` (UI state) and `js/core/data.js` (seed/live data) export every binding. Importers read them **live** (an imported binding reflects the latest value). Because an imported binding can't be reassigned by the importer:
  - **Mutable scalars** are written through a per-name setter — `setX(v)` (46 in state.js; `setPermissions` is the only one in data.js).
  - **Const collections** (Sets, arrays, the `ASSIGN_RULES_RR_INDEX` object) are mutated **in place** (`.add`/`.clear`/`.push`/`.splice`/`obj[k]=`) and need no setter. `bootstrap.js` swaps live API data in via `target.length = 0; target.push(...)`, preserving array identity so importers see new contents.
  - Setter naming: `setCamelCase`; add a `Value` suffix only to dodge a collision with an existing feature function (`setComposeTabValue`, `setSettingsTabValue`).

- **Events use data-action delegation.** Inline `on*=` handlers were migrated to `data-action="ns.fn"` dispatched through `js/core/event-delegation.js`. Cross-module calls are direct ES imports.

## CI gates — run before pushing (`.github/workflows/ci.yml` runs them on every PR)

```bash
bun build js/app.js > scripts/app.bundled.js              # 1. build
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
- Bundling regex/script tip: `git ls-files js` (not a `**` pathspec); use `String.raw` for regex in scripts (template literals eat `\w`/`\b`); files are CRLF — make literal-replacement scripts EOL-aware.

## Workflow

Feature branch per change, PR, then `/cem-pr-loop` (Octopus review) to a 4+/5 score before merge. When merging a stack, don't `--delete-branch` a PR that's still the base of another open PR (it auto-closes the child) — retarget children to `main` first.
