# Backup & recovery

The stated backup, durability, and recovery posture for Respovia. This is a one-page
operational reference — what holds data, how it's protected, how to restore it, and the
open items to firm up before the posture can be called guaranteed.

> Status: **posture + runbook**, updated for the self-hosted database (2026-08). Items
> marked **[action]** are recommended hardening not yet in place.

## Where the data lives

| Store | Holds | Backed up by |
|---|---|---|
| **Dokploy Postgres** (`respovia-db`, postgres:17 on the company server) | All application data — tickets, messages, customers, workspaces, audit log, and Better Auth's own tables (auth lives in the same database). | Nightly `pg_dump` via the `respovia-db-backup` sidecar app (`deploy/backup/`) → private Cloudflare R2 bucket. |
| **Cloudflare R2** | Uploaded brand assets (logos), file attachments, **and the database dumps** (separate, private bucket). | R2 object durability. |
| **Dokploy apps** (respovia-api / respovia-web) | Nothing durable. The frontend and API are **stateless** and rebuilt from source on every deploy. | Not applicable — recover by redeploying. |
| **GitHub** (`Art-of-Technology/maestro-desk`) | Source of truth for code **and** the database schema (`db/migrations/`). | Git history + GitHub. |

Because auth data shares the Postgres database and the schema is reproducible from
`db/migrations/`, a single database restore recovers the entire application state; the app
tier is recovered by redeploying from GitHub.

## Backup mechanisms

- **Database.** The **`respovia-db-backup` sidecar application** (image built from
  `deploy/backup/` — postgres:17 client + aws-cli + crond) runs `pg_dump -Fc` of
  `respovia-db` over the internal Docker network every night at 02:00 UTC (before the
  03:00/04:00 app crons, so dumps predate the retention purge) and uploads it to a
  **dedicated private R2 bucket** (`respovia-db-backups`, prefix `nightly/`), pruning to
  the newest 14. It also takes a backup on every deploy of the sidecar
  (`RUN_ON_STARTUP=true`). Config/credentials live only in the sidecar's Dokploy env
  (bucket-scoped R2 token — the app's asset-upload keys can't touch this bucket, and vice
  versa). Note: Dokploy's *native* backup feature isn't used — S3 destinations are
  owner/admin-only on the shared company panel. Recovery point = the last nightly dump,
  so **RPO is up to 24 h** — a real step down from Neon's PITR; see the open actions.
- **File storage (R2).** Objects are stored with Cloudflare's high object durability.
  Object **versioning is not assumed to be on [action]** — enable bucket versioning (or a
  lifecycle/replication policy) so an overwritten or deleted asset can be recovered, not
  just a lost one.
- **Code & schema.** Everything needed to rebuild both apps is in Git; no build artefact
  needs backing up.

## Targets

| Metric | Target | Basis |
|---|---|---|
| **RPO** (max data loss) | ≤ 24 h — DB; last-write — R2 assets | nightly pg_dump |
| **RTO** (time to restore) | database within ~1 hour; app within minutes | pg_restore from R2 + Dokploy redeploy |
| **Retention** | per the Dokploy backup schedule's keep-count | R2 |

## Restore runbook

**Database — restore from a nightly dump (data loss, corruption, or a bad migration):**
1. Fetch the chosen dump from the private R2 backups bucket (R2 console →
   `respovia-db-backups/nightly/`, or `aws s3 ls` with the sidecar's credentials).
2. Restore into a scratch database first and verify the expected data:
   `pg_restore --no-owner --no-privileges -d <scratch-url> <dump>`.
3. Stop `respovia-api` in Dokploy, restore into the production database (drop/recreate or
   `pg_restore --clean`), then start the API again. The boot-time migration pass re-applies
   anything newer than the dump.
4. Confirm health: `GET /api/v1/health` = 200 and `GET /api/v1/health/ready` proves
   connectivity (`/ready/neon` is a legacy alias).

**File assets (R2):** if versioning is enabled, restore the prior version of the affected
object(s). Assets are non-critical to app function (missing logos degrade gracefully).

**Application tier (Dokploy):** redeploy the last-good commit from GitHub — there is no
durable state to recover. Database migrations re-apply automatically at API-container boot
and are idempotent (already-applied files are skipped).

## Interaction with GDPR erasure & retention

Respovia **intentionally deletes** data: the retention cron purges resolved tickets
past each brand's window, and erasure fulfils right-to-be-forgotten requests. Restoring a
dump taken *before* such a deletion will **resurrect** that data. After any restore that
crosses an erasure or purge, re-run the relevant erasure(s) so deleted personal data does
not silently return. Record restores that cross a GDPR deletion. The dumps themselves
contain personal data — that is why the backups bucket must stay private and access-scoped.

## Responsibilities & open actions

- **Platform operator** owns the company server, the Dokploy panel, the Cloudflare account,
  the restore runbook, and the actions below.
- Open actions to move this from "posture" to "guaranteed":
  - **[action]** enable R2 bucket versioning (or lifecycle/replication) on the assets bucket.
  - **[action]** run a **restore drill** — pg_restore a nightly dump into a scratch database
    and verify the app comes up against it — and repeat periodically. An untested backup is
    a claim, not a guarantee.
  - **[action]** consider WAL archiving (e.g. wal-g) or more frequent dumps if a ≤24 h RPO
    proves too coarse.
  - **[action]** monitor backup success — a silently failing nightly dump is the classic
    backup failure mode (wire it to the ops-alert system).
