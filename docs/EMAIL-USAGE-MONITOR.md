# Email usage monitor

Platform admins see the latest account-wide estimate in Platform > Brands.
An hourly GitHub Actions job (minute 17) invokes the existing authenticated
cron mechanism. Manual Actions runs can select `email-usage`; the CLI accepts
the same job name. Reads of the status never contact Postmark or send alerts.

Configure the API environment:

- `POSTMARK_ACCOUNT_TOKEN`: existing account token, used only on the server.
- `EMAIL_USAGE_ALLOWANCE`: included emails, default 10000.
- `EMAIL_USAGE_RENEWAL_DAY`: actual monthly renewal day, 1–31; default 0 keeps
  the monitor unconfigured. Shorter months clamp to their last day.
- `EMAIL_USAGE_SLACK_WEBHOOK_URL`: optional dedicated Slack destination; falls
  back to `SLACK_ALERT_WEBHOOK_URL`. Without either, the panel still warns but
  no external usage notification is sent. Do not enable a destination without
  the operator's authorization.

The estimate adds sent-message recipient counts (all streams, including archived) and processed inbound
message counts for every server returned by the account API, including Sandbox
servers. Date boundaries use Eastern time to match Postmark's filters. The
billing date must be reconfigured if the subscription changes. This is not an
invoice: expired inbound records, deleted servers, provider counting differences
and billing cutover times can make totals differ. Postmark remains authoritative.

No partial scan replaces the last complete snapshot. Failures mark it unavailable;
two-hour-old results or results for a different allowance/cycle are stale. Both
are shown as unknown current usage, never as a healthy zero count. A configured
job failure returns `ok:false`, causing the existing workflow to fail without
printing provider payloads or credentials. An unconfigured job also fails visibly.

Slack warnings use aggregate counts only and do not send through Postmark.
Only a newly reached 80%, 90% or 100% threshold is notified in each cycle and
allowance combination; a jump sends only the highest threshold. The database
serializes overlapping jobs. Failed Slack deliveries are retried next hour;
a crash after Slack accepts but before database commit can duplicate a warning.
The UI warnings do not depend on Slack. Paid plans normally allow overages, so
100% is a usage/billing warning, not a claim that mail will stop.

Limits: each poll has a 45-second provider budget, per-request timeouts, a
500-server maximum and the provider's 10,000-message search limit per outbound
stream and cycle. Accounts that exceed these limits fail visibly for an
operator to review. The monitor cannot detect mail that never reaches Postmark
or guarantee delivery of a specific message. Use delivery traces for that.
