# Backup & recovery

The stated backup, durability, and recovery posture for Maestro Desk. This is a one-page
operational reference — what holds data, how it's protected, how to restore it, and the
open items to firm up before the posture can be called guaranteed.

> Status: **posture + runbook.** Items marked **[confirm]** depend on the current Neon /
> Cloudflare plan and should be verified and pinned; items marked **[action]** are
> recommended hardening not yet in place.

## Where the data lives

| Store | Holds | Backed up by |
|---|---|---|
| **Neon Postgres** | All application data — tickets, messages, customers, workspaces, audit log, and Better Auth's own tables (auth lives in the same database). | Neon continuous backup + point-in-time restore. |
| **Cloudflare R2** | Uploaded brand assets (logos) and any file attachments. | R2 object durability. |
| **Vercel** | Nothing durable. The frontend and API are **stateless** and rebuilt from source on every deploy. | Not applicable — recover by redeploying. |
| **GitHub** (`Art-of-Technology/maestro-desk`) | Source of truth for code **and** the database schema (`db/migrations/`). | Git history + GitHub. |

Because auth data shares the Neon database and the schema is reproducible from
`db/migrations/`, a single Neon restore recovers the entire application state; the app tier
is recovered by redeploying from GitHub.

## Backup mechanisms

- **Database (Neon).** Neon continuously retains write-ahead history, enabling
  **point-in-time restore (PITR)** to any moment within the retention window — you branch
  the database at a chosen timestamp. Recovery point is effectively seconds of data loss.
  The **retention window length is plan-dependent [confirm]** (verify the current Neon plan
  and record the exact window below).
- **File storage (R2).** Objects are stored with Cloudflare's high object durability.
  Object **versioning is not assumed to be on [action]** — enable bucket versioning (or a
  lifecycle/replication policy) so an overwritten or deleted asset can be recovered, not
  just a lost one.
- **Code & schema.** Everything needed to rebuild both Vercel projects is in Git; no build
  artefact needs backing up.

## Targets

These are the intended targets for the interim/pilot posture, to be confirmed against the
plan above:

| Metric | Target | Basis |
|---|---|---|
| **RPO** (max data loss) | seconds — DB; last-write — R2 | Neon continuous WAL; R2 durability |
| **RTO** (time to restore) | database within ~1 hour; app within minutes | PITR branch + Vercel redeploy |
| **Retention window** | **[confirm]** — record the Neon plan's PITR window | Neon plan |

## Restore runbook

**Database — point-in-time restore (data loss, corruption, or a bad migration):**
1. In the Neon console, create a **branch at the target timestamp** (just before the
   incident).
2. Verify the branch has the expected data.
3. Repoint the production `DATABASE_URL` to the restored branch (update the secret in the
   API's Vercel project **and** in the GitHub `Production` environment), then redeploy the
   API. See [`PROD_SETUP.md`](../PROD_SETUP.md) for the exact env/secret locations.
4. Confirm health: `GET /api/v1/health` = 200 and `GET /api/v1/health/ready/neon` proves
   connectivity.

**File assets (R2):** if versioning is enabled, restore the prior version of the affected
object(s). Assets are non-critical to app function (missing logos degrade gracefully).

**Application tier (Vercel):** redeploy the last-good commit from GitHub — there is no
durable state to recover. Database migrations re-apply automatically on deploy to `main`
and are idempotent (already-applied files are skipped).

## Interaction with GDPR erasure & retention

Maestro Desk **intentionally deletes** data: the retention cron purges resolved tickets
past each brand's window, and erasure fulfils right-to-be-forgotten requests. A PITR
restore to a point *before* such a deletion will **resurrect** that data. After any restore
that crosses an erasure or purge, re-run the relevant erasure(s) so deleted personal data
does not silently return. Record restores that cross a GDPR deletion.

## Responsibilities & open actions

- **Platform operator** owns the Neon and Cloudflare accounts, the restore runbook, and the
  actions below.
- Open actions to move this from "posture" to "guaranteed":
  - **[confirm]** the Neon plan's PITR retention window and record it in *Targets* above.
  - **[action]** enable R2 bucket versioning (or lifecycle/replication).
  - **[action]** run a **restore drill** — perform a PITR into a scratch branch and verify
    the app comes up against it — and repeat periodically. An untested backup is a claim,
    not a guarantee.
