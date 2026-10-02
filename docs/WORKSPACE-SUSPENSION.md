# Workspace suspension policy and release checks

This change implements brand/workspace suspension. It does not establish company contracts, company-level entitlements, or a new approval state for Maestro-created brands.

| State | Agent/API access | Background activity | Incoming email | Operator access |
| --- | --- | --- | --- | --- |
| Active | Existing membership and role checks apply | Existing permissions and budgets apply | Normal routing | Existing audited platform controls |
| Invitation pending | No workspace access until activation | No new privilege from the invitation | Workspace policy applies | Invitation administration |
| Suspended | Denied, including platform users using ordinary workspace APIs | No new customer sends or AI work; late results discarded; queued webhooks parked | Stored in the system inbox, with intended workspace recorded, without AI or automatic replies | Identity and audited platform recovery endpoints remain available |
| Deleted | Denied | Normal work denied; retention/erasure cleanup continues | Existing unrouted fallback | Existing archive/recovery policy |

The system inbox is restricted to platform administrators. Quarantined mail is not automatically replayed when a brand is reactivated. Its internal note and audit event identify the intended workspace. There is no verified automatic cross-workspace replay tool in this patch. After reactivation, an operator reviews the held message, checks the brand's existing conversation for duplicates, and transfers the required content/files into the correct brand using its normal ticket workflow. Record the source and destination ticket IDs in internal notes and resolve the held item only after confirming the destination. Do not reply from the system inbox. A dedicated transfer/replay screen remains a separate improvement.

Suspension waits for an already-started, bounded email/webhook/Slack send to finish. It cannot recall a message already accepted by another provider. Browser push notifications already queued by the push provider can remain deliverable until their existing expiry. Background AI calls already sent may finish and incur cost; their late results must not activate a reply. A suspension generation prevents work started before a suspend/reactivate cycle from becoming eligible again.

Pending webhook deliveries become exhausted with a suspension reason. Reactivation does not reset that state. Use the existing explicit retry action only after reviewing whether the old event is still appropriate. Knowledge refresh leases are cleared on suspension; future scheduled refreshes use current source data after reactivation. Snooze processing pauses and catches up after reactivation. Privacy retention, object deletion, audit verification and infrastructure monitoring continue: suspension must not silently suspend privacy obligations or recovery monitoring.

Private attachment and knowledge-download links now pass through the API and recheck workspace status. A link grants access to one file for five minutes. Downloaded copies and already-rendered browser content cannot be recalled. Previously issued direct R2 attachment links can remain valid for up to six hours after the last old application instance stops issuing them. Do not claim immediate file revocation during that transition. Wait out that period before accepting the suspension release gate; earlier invalidation would require an explicitly planned storage credential change.

## Before production release

- Apply the additive suspension-generation migration through the normal migration runner, then deploy the API. Keep the column/trigger if rolling back application code.
- Verify the system inbox exists, is available, and can be read only by platform operators. Rehearse domain-routed and reply-thread quarantine with synthetic mail and files.
- Rehearse suspension during a queued webhook, a send and an AI response. Verify reactivation does not release old replies or exhausted webhooks.
- Test private file links in the actual agent browser, including inline email images, expired links and knowledge downloads. Refresh the ticket to obtain fresh links. Measure API memory/egress under representative file traffic because downloads now pass through the API.
- Drain old application instances and allow previously issued direct storage links to expire. No production storage credentials are rotated by this change.
- Verify Maestro selection/player lookups, public portal access, ordinary workspace APIs, and operator recovery against a suspended synthetic brand.
- Existing sessions can retain rendered data in their browser; suspension stops new access, not copies already received. Record that limit in operator guidance.

The patch and isolated tests are evidence for code behavior, not evidence that these live release checks have been performed. Production deployment and customer onboarding are separate approvals.
