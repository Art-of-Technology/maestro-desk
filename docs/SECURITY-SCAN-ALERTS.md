# Dependency security scan alerts

`Security scan alerts` uses the existing `SLACK_DEPLOY_WEBHOOK_URL` secret. No new subscription, service or application permission is needed. It activates when merged to main.

- Completed failed, timed-out or cancelled dependency scans notify Slack with a fixed GitHub run link. A queued notification rechecks the run so a successful rerun suppresses a stale failure.
- Alerts distinguish confirmed moderate-or-higher vulnerabilities from a scan that could not complete. The scanner validates Bun's JSON report and exit status, then records the outcome in named GitHub job steps. The monitor reads only the current run attempt. Missing, unreadable or conflicting results produce an outcome-unknown message, never a vulnerability claim.
- An hourly check at :35 UTC independently checks scheduled runs. The daily scan is due at 06:15 UTC, with two hours of grace. The first overdue check is normally 08:35 UTC; GitHub may delay scheduled workflows. Manual scans cannot satisfy this check.
- Healthy scans send no message. Unreadable, incomplete or invalid history sends a separate status-unknown warning and fails the monitor job rather than claiming health.
- Messages contain run status and links only, never dependency reports, logs, credentials or customer data. The workflow checks out trusted main and does not download audit artifacts or execute the triggering commit.

## Delivery test and recovery

After merge, run `Security scan alerts` on **main**, choosing mode **test**. Expect one Slack message beginning `TEST: Respovia security scan alerts`, a successful delivery-record verification step and no claimed failure. Re-running the same monitor run should not send again. Use mode **check** to inspect actual schedule health; that mode can send a real warning.

On a failure warning, inspect the linked scan, fix the cause and rerun the audit. A successful manual run establishes dependency health but does not repair a missing schedule: check that the next scheduled audit succeeds. On an unknown-status warning, inspect GitHub access and monitor logs. Slack delivery or cache verification errors fail the job without printing upstream response details.

Confirmed sends use GitHub Actions cache records: one warning per failed audit run ID, one overdue warning per expected UTC date, and one unknown-status warning per UTC date. A test uses its monitor run ID. All monitor invocations share a concurrency group. Failed and overdue are distinct incidents, so an overdue run that later fails can produce a failure warning too.

Cache eviction/deletion can permit a repeat. Slack delivery and saving its cache receipt are not transactional: after a timeout or failed receipt save, check Slack before retrying. No automatic delivery retries are used. If hourly GitHub scheduling itself stops, this GitHub-hosted monitor cannot alert until it resumes; independent external monitoring would be needed to cover a complete Actions outage.

Offline tests: `node --test scripts/dependency-audit-result.test.mjs scripts/security-audit-monitor.test.mjs scripts/deployment-alert.test.mjs scripts/wrap-up-monitor.test.mjs`.
