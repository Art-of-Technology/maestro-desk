# Maestro Desk — Implementation Plan

> Companion to `REVIEW-PUNCHLIST.md`. Turns the 2026-06-19 review into a sequenced,
> dependency-aware delivery plan. Status: **proposal for owner sign-off.**
> Effort sizes are rough (S ≈ ≤1 day, M ≈ 2–4 days, L ≈ 1–2 weeks) and assume one
> dev working the existing feature-branch + Octopus-review flow.

---

## 1. Guiding constraints (decisions baked into the sequencing)

1. **Name & domain are deferred to the very end.** The service-desk product name
   ("Maestro Desk") is not final, so we do **not** buy the product domain yet and we do
   **not** hard-code the product name anywhere new.
2. **Email is decoupled from the product domain.** Transactional email (invites,
   magic-links, CSAT) needs *a* verified sending domain — not the product one. We use an
   **interim domain already owned by STech** (e.g. a `weezboo.com` subdomain) for sending
   now. Inbound *branded* email ticketing is the only thing that waits for the final domain.
3. **Pilot runs on portal + in-app ticketing** on the existing interim `*.vercel.app`
   hosts. This path needs no product domain, so a real pilot can start after Phase 2/3.
4. **Branding is made configurable** (Phase 5 cross-cutting) so the eventual name decision
   is a `.env` + DB-config change, not a code edit or redeploy of new code.
5. **Process unchanged:** one feature branch per item, Octopus review ≥ 4/5 before merge,
   CI must pass. Migrations are raw SQL in `db/migrations/`. Stack guardrails in `CLAUDE.md`
   are absolute (Neon / Better Auth / R2 / Pubby / Vercel / Hono / Bun).

---

## 2. Phase sequence & why this order

The order is **risk-and-dependency driven, not severity-driven.** We shrink the codebase
before we test/secure/translate it, harden before we pilot, build compliance before EU
customers, and leave the name/domain rename for last.

```
P0  Hotfix ───────────────────────────────────────────────► (hours)
        │
P1  Slim down & housekeeping ──► shrinks surface to test/secure/i18n
        │
P2  Security & safety hardening ──► PILOT-READY GATE (portal-only)
        │
        ├──────────────┐
P3  Multi-brand        P4  Compliance build-out  ◄── parallelizable after P2
    scaling                  │
        │                    │
        └────────┬───────────┘
                 ▼
P5  Product completeness & brandable shell ──► EXTERNAL-CUSTOMER GATE
                 │
P6  Name decision → domain purchase → branded email cutover  ◄── LAST
```

**Parallelism:** P3 (multi-brand) and P4 (compliance) are independent and can run
concurrently if two devs are available. Everything else is sequential.

---

## Phase 0 — Immediate hotfix
*Goal: stop the active data leak. Effort: S. Blocks nothing; do today.*

| Item | Punch-list | Branch | Size |
|---|---|---|---|
| Remove magic-link URL + email from prod logs (`public.ts:294`); structured log, scrub retained logs | P0 | `fix/portal-auth-log-leak` | S |

**Acceptance:** no auth token or PII in any `console.*`; a grep of the route confirms; a log
sample post-deploy shows the redacted form.

---

## Phase 1 — Slim down & housekeeping
*Goal: delete dead/decorative code so later phases have less to test, secure, and translate.
Effort: M–L total. Depends on: P0. Do before P2.*

| Item | Punch-list | Branch | Size |
|---|---|---|---|
| Delete workflow engine + route + UI (`lib/workflow-engine.ts`, `routes/workflows.ts`, `web/js/workflows/`) | P3-rm | `chore/remove-workflow-engine` | M |
| Collapse roles/permissions grid to the `is_admin` flag (drop `role_permissions` reads, `routes/permissions.ts`, `web/js/roles` matrix) | P3-rm | `chore/collapse-permissions` | M |
| Defer/remove Stripe + Shopify *player* integrations (`lib/stripe-client.ts`, `lib/shopify-client.ts`, `routes/integrations.ts` paths) | P3-rm | `chore/remove-player-commerce-integrations` | M |
| Defer custom-fields trio (feature-flag off, or remove) | P3-rm | `chore/defer-custom-fields` | M |
| Trim CSAT reminder cadence → single send; remove sentiment auto-priority-bump (keep scoring) | P3-rm | `chore/trim-csat-and-sentiment-bump` | S |
| Housekeeping: strip stale Supabase section from `CLAUDE.md`; delete legacy `supabase/` dir once ported | P3-house | `chore/docs-supabase-cleanup` | S |

**Sequencing note:** removals carry regression risk — each needs the render/route smokes
green and a quick manual pass. Do the two confirmed-dead ones (workflow engine, permissions
grid) first; the "defer" items can be feature-flagged instead of deleted if the team wants a
reversible path.

**Acceptance:** smokes pass; no dangling imports (static import audit); app boots; the
removed UI is gone from nav; a migration drops the now-unused tables (or they're left inert
with a note).

---

## Phase 2 — Security & safety hardening  →  **Pilot-ready gate**
*Goal: make the portal pilotable without fear. Effort: L. Depends on: P1.*

| Item | Punch-list | Branch | Size |
|---|---|---|---|
| Rate-limit public portal (ticket-create + magic-link); consider CAPTCHA | P1 | `feat/portal-rate-limiting` | M |
| Per-brand ticket `display_id` sequence (replace random) + unique constraint + backfill plan | P1 | `fix/ticket-display-id-sequence` | M |
| Gate backend tests + typecheck in CI (`bun test`, `bun run typecheck`) | P1 | `ci/gate-backend-tests` | S |
| Tenant-isolation test suite (cross-workspace negative tests on auth/authz/tickets/portal) | P1 | `test/tenant-isolation-suite` | L |
| Defense-in-depth: add `workspace_id` predicate to sub-resource queries (`tickets.ts:163-168,519`, `inbox.ts:113`) | strengths-note | `fix/workspace-scope-subqueries` | S |
| Observability: Sentry (or equiv) + structured logging + uptime checks on `/health`,`/ready/neon` | P1 | `feat/observability` | M |

**Acceptance / pilot gate:** CI runs and passes backend tests + isolation suite; portal
endpoints rate-limited (verified by load test); no two tickets can share an id; errors land
in Sentry; uptime alert fires on a forced `/ready/neon` failure. **After this phase a real
external pilot can run on the interim hosts, portal + in-app only.**

---

## Phase 3 — Multi-brand scaling
*Goal: the stated use case — one agent seamlessly covering many brands. Effort: M–L.
Depends on: P2. Can run parallel to P4.*

| Item | Punch-list | Branch | Size |
|---|---|---|---|
| **In-session workspace/brand switcher** (header control re-stamping `X-Workspace-Id` + `X-Brand-Id`; uses existing `whoami` memberships) | P1 | `feat/in-session-brand-switcher` | M |
| Consolidate DB pools / confirm pooled `DATABASE_URL` (`db.ts`, `auth.ts`) | P3-scale | `chore/db-pool-consolidation` | S |
| Keyset pagination for ticket lists (drop `count(*) over()`) | P3-scale | `perf/ticket-keyset-pagination` | M |
| Multi-row insert on ticket merge (`tickets.ts:692-698`) | P3-scale | `perf/ticket-merge-bulk-insert` | S |
| Batch/shard cross-workspace crons (`cron.ts:37-45`); review cadence vs Vercel plan | P3-scale | `perf/cron-batching` | M |

**Acceptance:** an agent in ≥2 brands switches in-app without re-login; ticket list paginates
by cursor; cron job processes N workspaces in bounded batches; pool count per instance
verified against Neon limits under a concurrency test.

---

## Phase 4 — Compliance build-out (GDPR + iGaming)
*Goal: defensible for regulated / EU customers. Effort: L (largest workstream).
Depends on: P2. Can run parallel to P3. **Get DPA/lawful-basis decisions from the owner up front.***

| Item | Punch-list | Branch | Size |
|---|---|---|---|
| Right-to-erasure endpoint — null `customers` PII **and** write `gdpr_erasures` audit row | P2 | `feat/gdpr-erasure` | M |
| Extend erasure to all PII surfaces (`ticket_messages.body`, `customer_notes`, `subject`, `csat_comment`, `inbox_messages`) | P2 | `feat/gdpr-erasure-full-coverage` | M |
| Data-subject + workspace export | P2 | `feat/data-export` | M |
| Retention/TTL policy + purge cron (tickets, messages, events, audit, ai_usage) — configurable per gambling rules | P2 | `feat/data-retention` | M |
| Read-access audit logging of player data (who viewed balance/KYC) + make audit log append-only/tamper-evident | P2 | `feat/player-access-audit` | M |
| LLM data boundary: per-workspace opt-out + minimization before Anthropic calls; document lawful basis | P2 | `feat/llm-pii-boundary` | M |
| RG-flagged-player gate before auto-reply (`triage.ts:369-406`) | P2 | `feat/rg-autoreply-gate` | S |
| CSAT/reminder sends honor consent + bounce-suppression + add unsubscribe link | P2 | `fix/email-consent-suppression` | S |
| Attachments (if wired): per-workspace signed R2 URLs + delete-on-erasure (never the public logo pattern) | P2 | `feat/secure-attachments` | M |
| Document sub-processor list + Art. 28/44 transfer basis (Anthropic, Postmark, R2, Slack, Pubby) | P2 | `docs/subprocessors-dpa` | S |

**Owner decisions needed before coding:** (a) the retention window(s) required by target
gambling jurisdictions; (b) lawful basis + DPA status for sending player PII to Anthropic;
(c) whether attachments ship at launch at all.

**Acceptance:** an erasure request nulls all PII surfaces and leaves an audit row; export
produces a complete bundle; purge cron deletes past-retention rows; player-record views appear
in the audit log; a workspace can disable player-PII-to-LLM; CSAT respects consent/bounce.

---

## Phase 5 — Product completeness & brandable shell  →  **External-customer gate**
*Goal: it feels like a product you can sell. Effort: L. Depends on: P2 (and benefits from P1's
slim-down). The branding workstream here is what makes the name decision cheap later.*

| Item | Punch-list | Branch | Size |
|---|---|---|---|
| **Branding-configurable shell** — externalize product name, logo, email from-names, portal copy to config/env (no hard-coded "Maestro Desk") | constraint #4 | `feat/configurable-branding` | M |
| i18n framework + extract strings (do **after** slim-down; reuses the externalization pass) | P3-i18n | `feat/i18n-foundation` + per-area extraction PRs | L |
| Responsive pass (portal first — players are mobile; then agent app) | P3-i18n | `feat/responsive-portal`, `feat/responsive-app` | M–L |
| Accessibility: modal focus-trap + `aria-modal`/labelledby + Esc (`core/modal.js`), `aria-live` for realtime, audit | P3 | `feat/a11y-modal-and-live` | M |
| Self-service signup + subscription/billing (resume the paused Stripe-billing work — **product** billing, distinct from removed player-commerce) | P3 | `feat/self-service-signup`, `feat/subscription-billing` | L |
| End-user + admin + external-API docs | P3 | `docs/user-admin-api` | M |
| Backup / DR posture: document Neon PITR + R2 retention + restore runbook | P3 | `docs/backup-dr-runbook` | S |
| Portal token UX: rotation + friendly error surfaces (`portal.html`) | P3 | `fix/portal-token-ux` | S |

**Acceptance / external gate:** a new brand-owner can sign up, pay, and onboard unattended;
the UI is at least bilingual and usable on mobile; product name/logo come from config; docs
exist; DR runbook is written. **The product is now sellable on the interim hosts under a
working title.**

---

## Phase 6 — Name decision → domain → branded email  (LAST)
*Goal: put the final brand on it. Effort: S–M once the name is chosen. Depends on: everything;
specifically on Phase 5's configurable branding.*

1. **Owner decides the final product name.** (Business decision — unblocks the rest.)
2. **Register the domain** (`mcp__plugin_vercel_vercel__check_domain_availability_and_price`
   can price/buy via Vercel, or register externally).
3. **Set branding config** to the final name/logo (no code change — Phase 5 made this a config edit).
4. **Verify the product domain in Postmark** (MX/DKIM/SPF/DMARC); migrate transactional sending
   from the interim STech domain to the product domain.
5. **Enable inbound branded email ticketing** on the product domain (the one channel that was
   genuinely domain-blocked).
6. **Add the apex/custom domain in Vercel** for the SPA + API; retire `*.vercel.app` references.
7. **Per-brand custom domains** (already-built plumbing: `postmark-domains.ts`,
   `workspace_email_domains`) re-verified end-to-end.

**Acceptance:** branded email round-trips (send + receive); SPA/API serve from the product
domain; DKIM/DMARC pass; per-brand sender domains verified.

---

## 3. Cross-cutting workstreams (run continuously, not a phase)

- **Testing:** every feature PR ships tests; the isolation suite (P2) grows as routes change.
- **Observability:** once live (P2), wire alerts for each new critical path (erasure, billing).
- **Branding-configurability:** seeded in P5 but every new user-facing string from P1 onward
  should go through config/i18n, not hard-coded — so we don't re-do it.
- **Migrations discipline:** each schema change = one timestamped SQL file; the deploy-time
  migration action already applies them on merge to main.

---

## 4. Risk register

| Risk | Phase | Mitigation |
|---|---|---|
| Deleting "defer" code breaks a hidden dependency | P1 | Feature-flag instead of delete where unsure; smokes + manual pass |
| Isolation regression after RLS removal | P2 | Dedicated negative-test suite is the backstop RLS used to be |
| Erasure misses a PII surface → incomplete DSAR | P4 | Enumerate every PII column up front; test asserts all are nulled |
| Retention window wrong for a jurisdiction | P4 | Owner confirms windows before coding; make it configurable |
| Interim email domain hurts deliverability/reputation | P2/P6 | Use a subdomain (e.g. `desk.weezboo.com`) with its own DKIM; warm it |
| Name change after Phase 5 leaks into code | P5/P6 | Branding-config workstream keeps the name out of code entirely |
| Billing complexity (paused before) | P5 | Scope to one plan, card + trial, as previously stored |

---

## 5. Gates (definition of done at each milestone)

- **Pilot-ready (end P2):** hardened, tested, observable, portal-only, interim hosts.
- **Compliance-ready (end P4):** erasure/export/retention/audit live; EU pilot defensible.
- **Sellable (end P5):** self-service signup + billing; brandable; localized; documented.
- **Launched (end P6):** final name, product domain, branded email — the only domain-gated work.

---

## 6. Suggested first moves

1. Merge Phase 0 hotfix today.
2. Open the two confirmed-dead removals (workflow engine, permissions grid) — fast, high-value.
3. In parallel, get the three **owner decisions** for Phase 4 (retention windows, Anthropic
   DPA/lawful basis, attachments yes/no) moving, since they gate the largest workstream.
4. Pick the interim transactional email subdomain so Phase 2 isn't blocked on it.
