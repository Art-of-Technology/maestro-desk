# Maestro Desk — Engineering Punch-List

> Source: platform review, 2026-06-19. Owner-facing summary is the separate artifact;
> this is the dev-facing version with file/line references.
> Severity: **P0** drop-everything · **P1** before external pilot · **P2** before regulated/EU
> customers · **P3** product polish. Line numbers are approximate (review-time HEAD) — confirm
> before editing.

---

## P0 — do first

- [ ] **Stop logging magic-link tokens & customer email in prod.** `api/src/routes/public.ts:294`
  `console.log('[portal-auth] magic link for ${email}: ${url}')` ships a live auth token + PII
  to Vercel runtime logs. The code comment already says to remove it. Replace with a structured
  log that omits the URL; scrub any retained logs. *(GDPR PII-in-logs + auth-token leak.)*

---

## P1 — before any external pilot

### Domain & email
- [ ] **Register the product domain.** `PROD_SETUP.md:7-19,69-80` — running on `*.vercel.app`;
  inbound/outbound email ticketing cannot run without MX/DKIM on a real domain. Blocks the core
  helpdesk feature. Per-brand sender plumbing already exists (`api/src/lib/postmark-domains.ts`,
  migration `20260530210000_*` / `workspace_email_domains`) — the root domain is the prerequisite.

### Abuse / resilience
- [ ] **Rate-limit the public portal.** No rate limiting anywhere in the codebase (every
  `rate limit` hit is a comment). `api/src/routes/public.ts` exposes unauthenticated ticket
  submission + magic-link sending scoped only by workspace slug. Add Hono rate-limit middleware
  and/or Vercel WAF; consider CAPTCHA on submit. Targets: ticket-create + magic-link routes.

### Correctness at volume
- [ ] **Replace random `display_id` generation with a per-brand sequence.** Collision-prone
  `TK-${random 6 digits}` at `api/src/routes/tickets.ts:894-896`, `customers.ts:74`,
  `inbox.ts:11-13`, `public.ts:114-119`. No unique-constraint guard shown → two tickets can share
  an id within a workspace. Use a per-workspace sequence (or DB sequence + workspace prefix).

### Multi-brand UX (the stated use case)
- [ ] **Add an in-session workspace/brand switcher.** Data model + login picker already support
  multi-brand membership (`db/migrations/20260520120100_tenancy_and_users.sql` workspace_members
  M:N; `api/src/routes/whoami.ts:23-62`; `web/js/.../agent-login.js:59-71`), but the only
  `setWorkspaceId` callers are login, autoresume, and god `enterBrand`
  (`web/js/god/index.js:414-427`). An agent covering several brands must round-trip through login
  to switch. Quick-switcher (`web/js/quick-switcher/index.js:60-83`) is intra-workspace only.
  Build a header switcher that re-stamps `X-Workspace-Id` (+ `X-Brand-Id`) in session.

### Test gating
- [ ] **Run backend tests + typecheck in CI.** `.github/workflows/ci.yml` runs only frontend
  render smokes. Existing backend tests are ungated: `api/src/**/cors.test.ts`, `index.test.ts`,
  `routes/cron.test.ts`, `lib/postmark-outbound.test.ts`, `lib/r2.test.ts`. Add `bun test` +
  `bun run typecheck` jobs.
- [ ] **Add a tenant-isolation test suite.** RLS is gone; isolation now relies on every route
  remembering `where workspace_id = …`. ~331 test lines / ~10,977 src lines, zero coverage of
  `api/src/middleware/auth.ts`, `lib/authz.ts`, god panel, ticket CRUD, public portal. Add
  cross-workspace negative tests as the regression backstop RLS used to provide.

### Observability
- [ ] **Add error tracking + structured logging + alerting.** Only raw `console.*`; only health
  surface is `api/src/routes/health.ts` (`/health`, `/ready/neon`) with nothing consuming it.
  Sentry and monitoring are **not** on the forbidden-tools list — this is an unfilled gap, not a
  constraint. Wire Sentry + uptime checks against the health endpoints.

---

## P2 — before regulated / EU customers (GDPR & iGaming)

### Right-to-erasure & access (Art. 15 / 17 / 20)
- [ ] **Implement erasure.** `db/migrations/20260520121300_gdpr.sql` + `customers.erased_at`
  (`20260520120300_customers.sql:25,31`) are dormant — `erased_at` is only SELECTed
  (`api/src/routes/customers.ts:94`), never set; nothing writes `gdpr_erasures`. Build an endpoint
  that nulls PII **and** emits the audit row.
- [ ] **Cover all PII surfaces in erasure.** The current design only touches `customers`. PII also
  lives in `ticket_messages.body`, `customer_notes.text`, `tickets.subject`, `csat_comment`,
  `inbox_messages`. Anonymize/redact these too.
- [ ] **Add data-subject export.** No `/export` route exists. Provide per-customer (DSAR) and
  per-workspace (customer-owned) export.

### Retention (Art. 5(1)(e) + gambling record-keeping)
- [ ] **Define & enforce retention/TTL.** No purge job anywhere; `api/src/routes/cron.ts` only does
  webhook-retry + CSAT reminders. `deleted_at` is soft-delete only → rows persist forever. Add
  retention policy + purge cron for tickets/messages/`events`/`audit_events`/`ai_usage_log`.
  Gambling AML/KYC typically mandates a *defined* window (e.g. 5 yrs), so this cuts both ways.

### LLM data boundary
- [ ] **Decide lawful basis + add per-workspace opt-out for player PII → Anthropic.** AML is
  correctly excluded (`api/src/lib/player-context.ts:73-75`, RG removed `:77-79`) — good. But
  triage still sends name, balance, KYC status, jurisdiction, and raw thread bodies
  (`api/src/lib/triage.ts:160-176`, `player-context.ts:69-72`); sentiment sends 2k chars
  (`lib/sentiment.ts:84-95`); KB-suggest sends visitor questions (`lib/kb-suggest.ts:113`). Only a
  budget gate exists — no PII minimization, no per-brand toggle. Resolve against the pending DPA.

### Audit trail
- [ ] **Log reads of player data, and make the audit log tamper-evident.** `audit_events`
  (`db/migrations/20260520120600_activity_audit.sql:25`) is written only on admin mutations
  (`middleware/platform-admin.ts:48`, `god.ts`, `agents.ts`, `public.ts:191`, `webhooks.ts:51`,
  `workflow-engine.ts:138`). No record of who *viewed* a player's balance/KYC (`customers.ts`
  player lookup, ticket detail). Regulators expect this. Table is also a plain mutable table —
  consider append-only / hash-chaining.

### Consent & messaging
- [ ] **Gate CSAT/reminder sends on consent + bounce-suppression + add unsubscribe.**
  `api/src/lib/csat-survey.ts:79-88,256-265` ignores the `consent` column
  (`20260520120300_customers.sql:18`) and the bounce state (`lib/postmark-bounce.ts` /
  `user_email_prefs`), and has no unsubscribe link. Both data points exist; just consult them.
- [ ] **Don't auto-reply to RG-flagged players.** Auto-reply posts at `api/src/lib/triage.ts:369-406`
  with no responsible-gambling awareness (RG fetch was removed). Add a gate before auto-reply for
  flagged / self-excluded accounts. *(Duty-of-care.)*

### Storage hygiene
- [ ] **Do not wire player-document attachments to the public-read bucket.** `ticket_attachments`
  (`20260520120500_tickets.sql:78`) is schema-only; inbound attachments are discarded
  (`lib/postmark.ts:9`); the live bucket uses unsigned public URLs (`lib/r2.ts:112`, logos at
  `routes/workspace.ts:47`). If attachments go live, use per-workspace signed URLs + deletion-on-
  erasure — never the logo pattern.
- [ ] **Cross-border processors need DPAs + minimization.** Player PII flows to Anthropic, Postmark,
  Cloudflare R2, Slack (`lib/slack-notify.ts`), Pubby with no minimization layer and no per-
  workspace disable (except AI budget). Document Art. 28 terms + Art. 44 transfer basis.

---

## P3 — product completeness & polish

### Self-service & billing
- [ ] **No signup / subscription / checkout exists.** Only path is god provisioning + invite
  (`db/migrations/*provision_brand_fn.sql`, `api/src/routes/god.ts`, `api/src/lib/invite.ts`).
  Stripe code present is *player-data* context (`routes/integrations.ts:89-149`,
  `lib/stripe-client.ts`), **not** product billing. (Subscription work is paused per project notes.)

### Frontend reach
- [ ] **No i18n.** All strings hardcoded English across `web/js/*/index.js`, `web/index.html`,
  `web/portal.html`. Player-facing portal can't be localized without forking the frontend.
- [ ] **Effectively no responsive design.** One `@media` query total
  (`web/styles/pages.css:228`, dashboard grid). Customer portal unusable on mobile.
- [ ] **Minimal accessibility.** ~6 `aria-*` usages; `web/js/core/modal.js` has no focus trap,
  no `aria-modal`/`aria-labelledby`, no Esc handling; no `aria-live` for realtime updates.

### Docs & DR
- [ ] **No end-user / admin / external-API docs.** Only contributor/operator docs exist.
- [ ] **No documented backup / DR posture.** No backup cadence, PITR expectation, or restore
  runbook for Neon or R2.

### Scaling clean-ups (flagged in-code, fine for pilot)
- [ ] **Two connection pools per instance.** `api/src/lib/db.ts:25-38` (`max:5`, `prepare:false`)
  + a second `pg.Pool` in `lib/auth.ts:53-54`. Confirm `DATABASE_URL` is the pooled endpoint;
  consolidate pools.
- [ ] **Offset pagination + `count(*) over()` per ticket-list request.**
  `api/src/routes/tickets.ts:46-72` — switch to keyset before volume.
- [ ] **Row-at-a-time insert loop on ticket merge.** `api/src/routes/tickets.ts:692-698` → multi-row
  insert.
- [ ] **Cross-workspace cron sweeps grow with brand count.** `api/src/routes/cron.ts:37-45`
  (`processPendingDeliveries`, `processCsatReminders`) — batch/shard per workspace. Also: cadence
  is daily on Hobby plan (`api/vercel.json`, `PROD_SETUP.md:41`).
- [ ] **Polling fallback baseline load.** `web/js/.../list-sync.js:29` (60s) + presence heartbeats
  (`api/src/routes/presence.ts:14`, 15s) when Pubby is down. Pubby path is correctly per-workspace
  (`web/js/.../realtime.js:52`, `api/src/routes/pubby.ts:18-30`).

### Code to remove / collapse (see overkill section of the review)
- [ ] **Delete the dead workflow engine** (~820 LOC): `api/src/lib/workflow-engine.ts`,
  `routes/workflows.ts` (trigger shape mismatch `:50-51,80-81` vs engine `:72`; run is a stub),
  `web/js/workflows/`. `assign_role` action (`workflow-engine.ts:119-132`) also duplicates
  `lib/assign-rules-engine.ts`.
- [ ] **Collapse the decorative roles/permissions grid** (~600 LOC + schema): `permissions` /
  `role_permissions` tables, `routes/roles.ts`, `routes/permissions.ts`, `web/js/roles/index.js`.
  Nothing reads the keys — `lib/authz.ts` (`requireWorkspaceAdmin`) only checks `roles.is_admin`.
  Either enforce them or reduce to the admin flag.
- [ ] **Defer Stripe/Shopify player integrations** (~530 LOC): `lib/stripe-client.ts`,
  `lib/shopify-client.ts`, `routes/integrations.ts`. Likely irrelevant for iGaming.
- [ ] **Defer custom-fields trio:** `routes/custom-fields.ts`, `custom-values.ts`,
  `ticket-templates.ts`, `web/js/custom-fields/`, `web/js/ticket-templates/`.
- [ ] **Trim CSAT reminder cadence** (`lib/csat-survey.ts`, keep single send) and the
  **sentiment→auto-priority-bump** side-effect (`lib/sentiment.ts`, keep scoring).
- [ ] Lower priority: `routes/saved-searches.ts`, the sentiment-backfill route
  (`routes/tickets.ts:389`).

### Housekeeping
- [ ] **Remove the stale Supabase section from project `CLAUDE.md`** (RLS/advisor) — `PROD_SETUP.md:23`
  says Supabase is gone. Delete legacy `supabase/` directory once migrations are confirmed ported.
- [ ] **Portal token UX:** `web/portal.html` uses `localStorage` tokens with no rotation and
  surfaces raw API error messages.

---

## Keep — complexity that earns its place (do not cut)
AI triage (`lib/triage.ts`), assignment-rules engine (`lib/assign-rules-engine.ts`), auto-reply
(`lib/auto-reply.ts`), AI budget/cost metering (`lib/budget.ts`, `lib/anthropic.ts`), KB-suggest
(`lib/kb-suggest.ts`), the Maestro integration (`lib/maestro*.ts`, `routes/maestro.ts`,
`lib/player-context.ts`), and the email plumbing (Postmark inbound/outbound/bounce/domains).

## Strengths confirmed (so the gaps above read in context)
Tenant scoping is consistent across routes (no cross-tenant leak found); input validation is strong
(zod in 22/~30 route files); webhook idempotency is correct (`routes/webhooks.ts` — dedup, HMAC,
`FOR UPDATE SKIP LOCKED`, right 200/500 retry semantics); cron is `CRON_SECRET`-gated; CORS is
carefully reasoned (`api/src/index.ts:58-82`); god panel is behind `requirePlatformAdmin` + audit
(`middleware/platform-admin.ts`); errors are non-leaking (`index.ts:121-130`); env is schema-
validated at boot (`lib/env.ts`).

> ⚠️ One latent isolation note: several sub-resource queries aren't workspace-scoped and are safe
> only because the parent fetch was checked — `tickets.ts:163-168` (rely on `:155-158`),
> `inbox.ts:113`, `tickets.ts:519`. `time_entries` delete does it right (`tickets.ts:818-821`).
> Add the `workspace_id` predicate for defense-in-depth before a refactor reorders the parent check.
