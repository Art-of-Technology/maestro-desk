# Agent onboarding

Invitations create inactive memberships with `invitation_pending = true`.
Successful password registration activates only pending memberships. Re-sending
an invitation preserves the member's current status. A password reset cannot
reactivate a disabled member, and admins cannot activate a pending member before
registration. Removing the membership cancels access.

The password form requires matching passwords. The default guide covers five
steps; all topics remain available from Guides, with longer instructions under
More detail.

## Tagline follow-up — deferred by Jodi

New agents should skip announcements published before their first successful
login and receive announcements published afterward, across browsers/devices.
Existing agents must retain their announcement history.

On 29 September 2026, the served SDK at https://tagline.cipiti.ai/sdk/v1.js exposed
`init`, `check`, `on`, and `preview`, with automatic sync during initialization.
The sync response supplied a publication ID, version label and HTML, but no
publication timestamp. Acknowledging one publication revealed an older one.

Needed from Tagline: a supported, idempotent per-user baseline/cutoff that skips
all publications at or before first login, including announcements that become
eligible after a role/workspace change. Retries must retain the original cutoff
and must not hide newer announcements. Call it before SDK initialization; persist
first login per account and test service failures, retries and multiple devices.

Jodi chose to wait for reliable support instead of silently acknowledging a
backlog with failure/retry edge cases. The current integration is unchanged.

## Existing invitations

The migration deliberately preserves existing membership status. Older records
did not distinguish invited users from registered users. Do not infer acceptance
from an active flag or the existence of a credential/session: invitations created
both. Verify registration history before correcting an existing invitation.
