# S3: audit content and historical repair

This branch prevents unnecessary new permanent copies and erases attributable
activity text. It does not rewrite historical audit records. S3 historical repair
remains a release requirement. Base: S2, PR #614.

## Controls and administrator workflow

The database filters audit metadata before extending the hash chain, including
direct SQL insert paths. It keeps approved identifiers, counts, booleans, known
status/priority changes and controlled categories. It drops arbitrary text,
labels, subjects, addresses, raw errors and unknown metadata. IP and user-agent
fields are not populated. Identifiers still require a justified retention policy;
these records are not described as anonymous.

Useful narrative stays in existing activity records. Customer erasure redacts
their detail and author label while preserving event identity/kind, including
automatic-reply duplicate prevention. Parent deletion removes activity; database
guards prevent late personal-content writes and cross-workspace parent links.
New ticket/note audit entries retain customer attribution before retention can
remove their source. This does not recover missing links in older records.

Administrators can download a review export after erasure. It includes linked
activity, audit and erasure history and warns about unlinked records. Historical
audit text and historical erasure reasons may remain. Review staff/third-party
information before disclosure; attachment bytes and downstream copies are
separate. The UI selects a controlled reason rather than collecting new free text.
Older clients sending a narrative reason receive a validation error; direct legacy
database writers have unsupported reasons mapped to `other`.

## Evidence collected on 5 October 2026

A read-only production transaction (15-second statement timeout, ending in
ROLLBACK) found 362 audit rows, 280 rows with copied-text metadata keys, 68 with a
closure-note key and 7 audit entries referencing missing tickets. None of those
7 had a customer_id metadata key. There were 197 activity rows and no missing
ticket parents among those activity rows. These counts can overlap and are review
candidates, not a legal classification or proof of individual identity.

The full verifier checked 7 workspace chains with 0 failures. The configured
database role `respovia` was confirmed as superuser, role manager and audit-table
owner. Two connections used that role, including the inspection connection.
This alone does not identify the API's configured runtime role. The API terminal
selector exposed no containers, so runtime-role separation still requires direct
verification. Do not assume ordinary triggers constrain a database superuser.

## Read-only historical inventory

After this migration, run from `api/` with the intended database environment:

```
node --import tsx scripts/inspect-audit-history.ts --workspace WORKSPACE_UUID --limit 100
```

Continue with `--after SEQUENCE` from `next_after`. The tool is read-only, limits
each page to 500 rows and each statement to 30 seconds, and prints identifiers,
flags, privilege booleans and the current chain tail hash. It never prints row
content. `needs_review` includes metadata outside the prospective rules, not just
personal information; review before classifying. No apply option exists.

## Historical repair decision and rehearsal

1. Record the controller's retention/hold decisions and approved scope. Resolve
   missing attribution; never guess ownership from free-text matches or erase
   another customer's correspondence.
2. Verify API runtime privileges and separate ordinary application access from
   migration/repair authority. Test with a non-owner role; no application-accessible
   trigger bypass, arbitrary SQL endpoint or new production grant is included here.
3. Verify the full existing chain before repair. Keep an independently controlled
   receipt of workspace, pre-repair tail, approved scope, operator and operation ID.
   Do not preserve erased narrative or publish hashes of low-entropy personal data.
4. Rehearse explicit sanitisation and re-anchoring on isolated approved data. A
   changed chain is a documented integrity transition, not the untouched original.
   Use one atomic transaction per bounded workspace operation, serialize against
   audit inserts, reset the affected checkpoint, verify, and record the resulting
   anchor and counts. Fail on unexpected rows, broken pre-existing integrity or
   insufficient privileges. Prove rollback on interruption and safe retries.
5. Obtain approval of that concrete repair implementation and operating scope
   before production execution. Reconcile backups/restores and downstream copies.

No historical bypass or repair procedure is installed by this branch. Its design
must follow verified permissions and the retention decision above. The current
same-database chain cannot prove integrity against a privileged operator who
rewrites both data and verification checkpoints; an external receipt reduces that
trust dependency but cannot prove the deleted original narrative later.

## Validation and rollback

Exercise direct/helper metadata writes, marker removal, delayed writes in both
lock orders, repeat erasure, tenant separation, merged ownership, parent deletion,
administrator exports after erasure, and agent-report/automatic-reply behaviour.
Full/incremental verification and unauthorised edit/delete tests must pass alongside
PostgreSQL 17 migrations, Node 22 and combined security tests.

Deploy controls only after the prerequisite branches and staging rehearsal.
No automatic historical rewrite runs at boot. Keep database protections if
rolling application code back; older clients may need to omit a narrative reason
or reload. Do not disable immutability or rebuild old hashes as a rollback step.
