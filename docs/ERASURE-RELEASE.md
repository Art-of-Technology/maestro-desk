# S2: erasure and export release checks

This change closes the reproduced application-content gaps. It is not a statement
that every copy held by Respovia, a customer or a supplier has been erased.
It builds on the workspace-suspension branch (#612). Integrate and validate that
prerequisite before release. No historical repair is run by the migration.

## Behaviour

- Customer erasure clears legacy AI summaries/drafts, ticket tag associations and
  time-entry notes. It deletes message copies attributed to this subject on other
  customers' tickets, including their saved reviews. Destination owners and their
  own correspondence remain intact. Derived AI content on affected destinations
  is invalidated because it may have incorporated the removed copy.
- Repeating erasure scrubs again without creating a duplicate erasure audit row.
  The original completion date is retained. Object deletion still uses the durable
  outbox; a database success does not prove every storage deletion has finished.
- A merged profile whose tickets or journalled personal fields still belong to
  a survivor must be unmerged before erasure. This includes deleted source
  profiles; they receive a conflict instead of a misleading success. Their
  transferred history appears in the administrator export. Historical repair
  stops on such a conflict so an operator can resolve ownership explicitly.
- Database guards reject new personal content on erased tickets and known merge
  origins, including writes from older application instances. A simultaneous
  privacy/ownership change can return a retryable 409 rather than waiting in a
  deadlock. Redaction and non-content maintenance remain possible.
- Ticket and workspace privacy versions invalidate delayed AI results. Already
  consumed AI usage is still charged; discarded output is not stored or returned.
  Modern suggestions keep their existing source-deletion cascade, with an
  additional version check before persistence.
- Customer-facing replies, survey sends and mention emails recheck privacy at
  their bounded send boundary. A send already in progress completes before
  erasure obtains its lock. This does not retract an email already accepted by
  the delivery provider or erase a recipient's mailbox.
- Exports use one consistent database snapshot and add legacy AI, saved
  suggestions/shared drafts, saved reviews, time entries, tags and retained
  soft-deleted messages. Attributable merged copies and suggestions derived from
  the subject's tickets are included for administrator review. The export is
  **not automatically suitable for disclosure**: third-party/staff information
  requires review, and attachment bytes still require separate secure delivery.

## Historical repair: preview first

Run from `api/` with the intended database environment explicitly selected:

```
node --import tsx scripts/repair-erased-content.ts --workspace WORKSPACE_UUID --limit 100
```

The command lists only previously erased customer UUIDs and counts for the known
S2 omissions. These are not counts of all personal data in the system. It changes
nothing by default. `next_after` is the cursor for the next bounded page:

```
node --import tsx scripts/repair-erased-content.ts --workspace WORKSPACE_UUID --after LAST_UUID --limit 100
```

After an operator has reviewed scope, applicable retention/holds, recovery,
customer impact and authorisation, the same page can be applied with:

```
node --import tsx scripts/repair-erased-content.ts --workspace WORKSPACE_UUID --limit 100 --apply --confirm WORKSPACE_UUID
```

Each customer is a separate transaction. On failure the command stops; resume
after the last successfully reported UUID, or repeat the same page safely.
Keep the count-only output as an operation receipt. Confirm the object-deletion
outbox has drained, then rerun preview and the appropriate API checks. No repair
has been run against production as part of this change.

## Release and rollback

1. Apply the new migration to isolated PostgreSQL 17 and run the API regression
   suite, AI completion/erasure races, merged-copy tests and send/erasure races.
2. Validate the combined security branches, frontend build/import/header checks,
   route/detail smokes, and Node production runtime. Obtain the required review.
3. Rehearse on approved staging data. Exercise a rights request including reviewed
   files, multi-contact matching and failed storage deletion. Confirm expected
   retries are clear to administrators and agents.
4. Deploy controls before any separately approved historical repair. Preview
   the intended workspace and preserve the report; do not infer approval from
   permission to deploy application code.

Rolling back application code cannot recover erased personal data. Keep the
database guards and generation columns when reverting a faulty application
release; older writers may receive conflicts instead of restoring content.
Avoid automatic migration rollback that removes these protections. If a forward
fix is needed, pause affected workflows while preserving read/recovery access.

## Remaining release requirements

S3 must address personal free text in activity/audit history without invalidating
the tamper-evident audit chain. Shared tag-library text, externally copied knowledge,
unattributed/unrouted mail, logs and notification payloads require their own
attribution and retention review. This change does not erase arbitrary strings
across other customers or organisations.

Backups, downloaded exports, already delivered email/webhooks, supplier-held AI
inputs and staff records need the separate rights/retention processes in the audit
plan. A restore rehearsal must demonstrate that erased data is not reactivated.
The supplier contracts, retention rules, launch markets and AI release mode remain
business/privacy decisions; this code change does not decide them.
