# Runtime and maintenance database access

This is a release preparation change. It does not change production accounts,
credentials or grants at migration time. The deployed API login still needs
direct verification; the previously inspected database owner is a superuser.

Use a separate, fresh login for the API and scheduled application jobs. It must
have no owned objects, privileged role attributes or memberships. Keep the
migration/table-owner login in a separate operator/job environment, never in the
running API container. Credentials are supplied by the operator; none are created
or stored by these scripts.

## Rehearsal and release order

1. Apply migrations using the existing owner runner in a separate job/container.
2. Create a fresh unprivileged login through the database administrator. Use the
   table-owner connection for the preview below, confirming the exact database:

   ```
   node --import tsx scripts/configure-runtime-access.ts --role LOGIN --database NAME
   ```

3. Review the inventory and maintenance window. Add `--apply` only for an approved
   environment. This transaction revokes PUBLIC access to application objects and
   schema/temporary-object creation in this dedicated database, reviews the known
   privileged functions, and grants runtime CRUD on ordinary application tables.
   Audit rows permit SELECT/INSERT only; checkpoints and migration records permit
   SELECT only. New objects require a reviewed re-run of the grant inventory.
   Other applications must not share this database without a separate grant review.
4. Start the API with its fresh runtime `DATABASE_URL` and `DATABASE_BOOT_MODE=check`.
   Startup checks for pending migrations and excessive permissions without writing
   schema. A missing migration or an owner-level runtime fails startup. The default
   `migrate` mode preserves existing deployments until the explicit cutover.
5. Exercise sign-in, new brand provisioning, inbound mail, ticket activity,
   exports/erasure, retention and scheduled audit verification in staging. Verify
   the actual running connection identity and permissions, not only saved settings.
6. Confirm runtime cannot modify audit rows, checkpoints, schema, roles or trigger
   settings. Verify backups and monitoring credentials separately.

The existing API tenant checks remain essential: this is an application-wide
database role, not per-tenant row-level security. Brand provisioning still uses
the existing controlled privileged functions. Audit verification runs through
`audit_events_verify_checked`, which computes checkpoint updates itself and uses
the same audit-before-checkpoint lock order as maintenance. No general SQL or
historical-repair function is exposed to the runtime.

Apply future migrations with the same owner, then review/reapply grants before
starting the new runtime version. Owner credentials in an environment variable
alongside runtime credentials would defeat the separation and are not supported.

## Rollback and remaining decisions

Rehearse rollback with the restricted login. Older API versions that directly
write audit checkpoints cannot run this verification path under the new grants;
retain the wrapper-compatible release or use a forward fix. Do not restore
superuser permissions as an automatic recovery step. Credential rotation and
historical audit repair are separate operator actions. Neither executes at boot.
