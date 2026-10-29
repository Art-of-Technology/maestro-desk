# Dependency security scan alerts

`Security scan alerts` uses the existing `SLACK_DEPLOY_WEBHOOK_URL` secret. Delivery state is stored in `security-audit-receipts.json` on the dedicated `security-audit-state` branch. The workflow needs `contents: write` for that state file and retains `actions: read` for scan history and initial cache migration. It checks out trusted main without persisted credentials. No new service or subscription is needed.

- Completed failed, timed-out or cancelled dependency scans notify Slack with a fixed GitHub run link. A queued notification rechecks the run so a successful rerun suppresses a stale failure.
- Alerts distinguish confirmed moderate-or-higher vulnerabilities from a scan that could not complete. The scanner validates Bun's JSON report and exit status, then records the outcome in named GitHub job steps. The monitor reads only the current run attempt. Missing, unreadable or conflicting results produce an outcome-unknown message, never a vulnerability claim.
- An hourly check at :35 UTC independently checks scheduled runs. The daily scan is due at 06:15 UTC, with two hours of grace. The first overdue check is normally 08:35 UTC; GitHub may delay scheduled workflows. Manual scans cannot satisfy this check.
- Healthy scans stay quiet unless there is a confirmed failure notification to recover. A later clean scan sends one recovery message for the latest confirmed failure, linking both runs. Successful reruns and manual scans qualify, but do not clear overdue-schedule warnings. Newer or unfinished scans suppress stale recovery messages.
- Unreadable, incomplete or invalid history sends a separate status-unknown warning and fails the monitor job rather than claiming health.
- Confirmed vulnerability alerts include critical, high and moderate counts when available, counting each advisory ID once across packages. Conflicting severities, missing counts or invalid metadata retain the generic vulnerability message; missing counts are never shown as zero. Older runs remain supported.
- Messages contain run status, verified severity counts and links only, never dependency reports, logs, credentials or customer data. The workflow checks out trusted main and does not download audit artifacts or execute the triggering commit.

## Delivery test and recovery

After the first merge, run `Security scan alerts` on **main**, choosing mode **migrate**. This imports all available legacy security-alert cache receipts, including recovery receipts, across all pages, preserves their timestamps and verifies the saved file. It sends no Slack messages. An existing valid state file is left untouched. Normal checks never initialize missing state automatically. Receipts already evicted before migration cannot be recovered from the cache.

Then run mode **test** for one message beginning `TEST: Respovia security scan alerts`. The monitor verifies the durable receipt before reporting `sent`. Re-running the same monitor run should not send again. Mode **check** inspects schedule health and can send a real warning. All modes share the workflow concurrency group, so migration and sends cannot overlap within the workflow.

On a failure warning, inspect the linked scan, fix the cause and rerun the audit. A successful manual run establishes dependency health but does not repair a missing schedule: check that the next scheduled audit succeeds. On an unknown-status warning, inspect GitHub access and monitor logs. Missing, corrupt or unreadable receipt storage fails the job before sending; it cannot safely deduplicate an additional Slack warning.

The durable `receipts` map stores alert keys and confirmation timestamps only: one warning per failed audit run ID, one overdue warning per expected UTC date, and one unknown-status warning per UTC date. A test uses its monitor run ID. Failed and overdue are distinct incidents, so an overdue run that later fails can produce a failure warning too. No message content, credentials or customer data is stored.

Recovery uses a separate durable receipt keyed to the latest confirmed failed run ID, so subsequent clean scans do not repeat it. Missing failure receipts cannot justify recovery. Recovery still requires complete workflow history (up to 100 runs since that failure); exceeding that limit reports unknown status rather than guessing. Cache eviction no longer affects migrated receipts.

Before sending, the monitor saves and verifies a `pending` marker using the file SHA for optimistic locking. After Slack accepts the message, it replaces that marker with a confirmed receipt and verifies the saved file again. A failed or ambiguous send, or a failed confirmation save, leaves pending state and blocks subsequent sends. No automatic delivery retries are used.

To reconcile a pending delivery, run `node scripts/security-audit-reconcile.mjs` from the repository in an interactive terminal. It uses `GITHUB_TOKEN` if set, otherwise your existing `gh` login. The account needs repository contents write access and Actions read access. No token is displayed.

The command shows the pending alert, UTC start time, monitor history and receipt history. Check Slack and the failed monitor run, then type exactly `confirmed sent` to record confirmation and clear pending, or `confirmed unsent` to clear pending without recording delivery. Confirmation is timestamped at review time. Press Enter or enter any other text to leave unresolved. Missing receipts alone do not prove non-delivery. Non-interactive execution displays the pending details but cannot change state.

The command refuses to change state while a monitor is running or if the file changed during review. It preserves all existing receipts and verifies the save. It never sends or retries a Slack message; clearing an unsent delivery allows a later monitor to retry. If the save cannot be verified, check receipt history before trying again. Restore a missing/corrupt file from this branch's history instead of recreating it from expired caches.

Slack and GitHub are not one transaction, so exactly-once delivery is not guaranteed; pending state makes ambiguity visible and prevents unattended duplicates. Deleting the durable state or rewriting its history can still lose evidence. If hourly GitHub scheduling itself stops, this GitHub-hosted monitor cannot alert until it resumes; independent external monitoring would be needed to cover a complete Actions outage.

Offline tests: `node --test scripts/security-audit-reconcile.test.mjs scripts/security-audit-state.test.mjs scripts/dependency-audit-result.test.mjs scripts/security-audit-monitor.test.mjs scripts/deployment-alert.test.mjs scripts/wrap-up-monitor.test.mjs`.
