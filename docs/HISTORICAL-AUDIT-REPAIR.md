# Historical audit repair: operator procedure

This tool is release preparation, not authorisation to change production. It
removes disallowed metadata and IP/user-agent fields from an exact list of audit
rows. It retains event IDs, timestamps, actor references and target references.
Those references remain potentially personal data; this is not anonymisation or
a complete GDPR erasure process.

The repaired chain has a **declared integrity transition**. Its new valid hashes
do not prove that its old content was always minimised. Every operation records
the reviewed proposal, previous and replacement chain fingerprints, the policy
fingerprint, row counts and completion time. Keep the pending and committed
receipts outside the application database in controlled, independently retained
storage. A database owner can alter both the history and database receipt; a local
receipt alone is not independent custody or a digital signature.

## Release prerequisites

1. Complete `DATABASE-ACCESS-RELEASE.md`, including verification of the actual live
   API login. Keep operator credentials out of the API container. Apply migration
   `20261005180000_audit_repair_receipts.sql`; review/reapply runtime grants.
2. Approve a workspace-specific retention decision and a review confirming **no
   active holds anywhere in that workspace**. An exclusion preserves content but
   may have a recalculated chain link, so exclusions do not satisfy a legal hold.
   Record opaque UUID references to the decision and hold review. The tool checks
   their presence and format; it cannot establish their truth or legal validity.
3. Review the exact row IDs and exclusions. Missing/unrecognised targets are
   refused, never attributed by guesswork. A current parent is evidence of its
   current relationship only. Known merge history, transferred records and missing
   parents are refused for separate review. Independently review historical
   ownership before including a row. All unselected content is retained.
4. Rehearse backup restoration in an isolated environment. Restrict and expire
   backups under the approved policy. Restoring an old backup can resurrect the
   removed content: reconcile externally held receipts before reopening service.
   Do not automatically replay an old proposal against a restored database.
5. Schedule a short maintenance window across brands. Apply briefly locks the
   audit table and parent tables across workspaces because update-trigger control
   is table-wide. It refuses existing lock contention immediately. New requests
   may wait during the transaction; migrations and scheduled verification must be
   coordinated. Limits: 500 selected rows, 500 exclusions, 5,000 chain rows,
   10 seconds per SQL statement and 30 seconds per transaction (PostgreSQL 17).

## Preview and approval

Use a separate operator shell with `DATABASE_URL` set securely. Do not copy
credentials into commands, reports or receipts. From `api/`, prepare a JSON file:

```json
{
  "operationId": "00000000-0000-4000-8000-000000000101",
  "database": "CONFIRMED_DATABASE_NAME",
  "workspaceId": "00000000-0000-4000-8000-000000000102",
  "selectedIds": ["00000000-0000-4000-8000-000000000103"],
  "excludedIds": [],
  "decisionId": "00000000-0000-4000-8000-000000000104",
  "holdReviewId": "00000000-0000-4000-8000-000000000105",
  "holds": "none_in_workspace"
}
```

These are examples, not approvals. Supply actual reviewed IDs.

```
node --import tsx scripts/repair-audit-history.ts --request scope.json --out preview.json
```

Preview uses a read-only transaction. It checks the whole bounded chain and its
checkpoint, current parents and the sanitising policy. It outputs identifiers and
fingerprints, never historical narrative. Review and approve the exact preview
and its `proposalHash`. A hash detects changes; it is not an approval signature.

## Apply, verify and recover

Create the restricted receipt directory beforehand and establish its custody.
The tool flushes files and, on POSIX systems, their directory entries. Windows
does not expose the same directory flush through Node; verify storage durability
and independent receipt capture in the chosen operator environment before use.

```
node --import tsx scripts/repair-audit-history.ts --apply --proposal preview.json --receipt-dir RECEIPT_DIRECTORY --confirm REVIEWED_PROPOSAL_HASH
```

The command writes and flushes a pending file before touching history. Under
locks it checks the preview again, disables only the audit UPDATE guard, sanitises
only selected content, recalculates the workspace chain, restores the guard,
rebuilds only that workspace's checkpoint, and runs full and incremental checks.
All database changes and the receipt commit together. Any transaction failure or
connection termination rolls them back, including the trigger state. Other
workspace histories and checkpoints remain unchanged.

The forced-disconnection rehearsal also reproduced an abrupt Node/Postgres-driver
exit. Database rollback still passed independent verification; the command must
be treated as interrupted and its receipt checked using recovery. This change
does not claim to fix that underlying driver behaviour.

After commit it writes the external committed receipt. If the process stops or
that write fails, the CLI exits unsuccessfully but the database may have committed.
Establish the result with:

```
node --import tsx scripts/repair-audit-history.ts --recover --proposal preview.json --receipt-dir RECEIPT_DIRECTORY
```

Recovery performs no history changes. It reads the saved receipt and writes it
externally. The same operation ID and proposal are idempotent; a different
proposal under that ID is refused. Existing evidence files are never overwritten.
For a damaged/partial evidence file, preserve it and recover to a new controlled
directory. A committed external file without a database receipt is a restore or
custody incident requiring investigation, not a reason to repeat cleanup.

Verify the external receipt, both verification paths, enabled guards and ordinary
runtime denials before ending maintenance. Archive receipts under the approved
retention and access policy. Investigate any changed/broken/stale preview, active
hold or uncertain ownership; never weaken the guards simply to make apply succeed.

## Remaining historical work

This command covers `audit_events` only. Earlier application content can be
reviewed with the separate `repair-erased-content.ts` command and its approval
procedure. Legacy free-text `gdpr_erasures.reason`, unattributed activity, missing
targets, backups and downstream copies require separate decisions and follow-up.
Neither a clean chain nor a successful repair proves overall GDPR compliance.

PostgreSQL references: [transaction timeouts](https://www.postgresql.org/docs/17/runtime-config-client.html)
and [table locking](https://www.postgresql.org/docs/17/sql-lock.html).
