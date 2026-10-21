# Maestro workspace approval

Maestro Connect remains the authority for identity and brand access. A Respovia
workspace represents one Maestro brand. Users must retain Maestro access when
entering a workspace, including after an administrator approves its creation.

Platform administrators choose the policy under **Platform · Brands → New workspaces**:

- **Approval required** (default): users explicitly request a workspace for an
  accessible Maestro brand. The request records its brand, organisation, first
  requester and request date. Repeated requests for the same brand share one row.
  A pending request creates neither a workspace nor membership.
- **Automatic**: signing in can create a workspace for an accessible Maestro brand.
  Requests already pending still require explicit approval.

The first request for a brand sends an **ACTION REQUIRED: Respovia workspace
approval** Slack alert to the email-usage warning destination
(`EMAIL_USAGE_SLACK_WEBHOOK_URL`, falling back to `SLACK_ALERT_WEBHOOK_URL`). It
uses a prominent heading, amber accent, brand/organisation labels and an approval
panel link. Requester emails and customer records are not included. Clicking the
link opens the existing admin panel; it does not approve the request in Slack.
Repeated or concurrent submissions do not send another alert. Delivery is
best-effort with a five-second timeout: a Slack failure leaves the request safely
pending, logs a fixed warning and is not retried automatically. Existing pending
requests are not announced retroactively.

Only platform administrators can change the policy or approve a request. Approval
creates the workspace, records the decision and removes it from the pending list.
The requester clicks **Refresh brands** or signs in again to enter it. Approval
does not itself grant membership; Maestro access is checked again at entry.
Existing workspace memberships, role overrides and agent deactivations retain
their existing behavior. Archived and suspended brands cannot be recreated by
requesting access or enabling Automatic mode.

The policy and approval audit records commit in the same transaction as their
changes. Requests and provisioning take a per-brand database lock; changing
the policy serializes with automatic creation before the setting change returns.

Migration `20261021140000_workspace_approval.sql` also archives the exact
`testnewpagebuilderbrand-237301e6` workspace if present. It verifies its name and
that Test Casino and Space Casino remain active, preserves records and the
Maestro mapping, and records the archive. It does not modify Maestro itself.

Deploy the API and database migration before relying on the frontend controls.
If the database uses the separate restricted runtime login, the operator must
include the two new tables in the reviewed runtime grant inventory before
starting the new API (see DATABASE-ACCESS-RELEASE.md). The API fails closed if
registration settings are missing. A code rollback to the previous API restores
its automatic creation behavior even though the saved setting remains.

Release checks: confirm the saved policy is Approval required; only Test Casino
and Space Casino appear as brands; the system inbox remains separate. Verify an
unapproved synthetic brand cannot create a workspace via direct selection,
explicit requests deduplicate, only a platform admin can approve, and a freshly
verified Maestro login can then enter. Switching to Automatic must leave earlier
requests pending and archived brands inaccessible.
