# Hosted daily wrap-up monitor

GitHub Actions checks the weekday 17:30 Europe/London report at 18:35 and 20:35 UK time. Scheduling can be delayed; the second run retries a missed check. The monitor runs without Jodi's laptop. The report remains local until the [hosted report activation](DAILY-WRAP-UP.md) is completed.

The existing local `Documents/Codex/waiting-alerts/run.mjs` publishes the last confirmed `weekday-wrap-up/state.json` to repository variable `CODEX_WRAP_UP_RECEIPT` through the signed-in GitHub CLI. It sends only coverage and verification timestamps, the Slack message timestamp and the fixed channel ID. It never publishes report content or credentials. Unchanged receipts are skipped; failed syncs retry after five minutes while the laptop is awake. Set `CODEX_WRAP_UP_MONITOR_SINCE` to the activation date (`YYYY-MM-DD`) to avoid historical warnings.

The hosted workflow reuses `SLACK_DEPLOY_WEBHOOK_URL`. A morning catch-up does not satisfy that evening's report. Missing, malformed or future receipts cannot prove delivery. The warning distinguishes missing receipts from proven Slack delivery failures. Late receipts suppress later warnings.

After `HOSTED_WRAP_UP_ENABLED=true`, the monitor reads the confirmed receipt from `wrap-up-state.json` on branch `codex-wrap-up-state` instead of the laptop variable. An unreadable state file is treated as unconfirmed delivery. Hosted receipts record Slack webhook acknowledgement and the workflow run ID, without fabricating a message timestamp.

Confirmed warning deliveries create `wrap-up-warning-YYYY-MM-DD` Actions cache records scoped to main, independent of workflow-run artifacts (which disappeared during the live rerun test). Serialized runs inspect exact cache keys before posting, including manual reruns, and verify each save through the API because cache-save failures can otherwise be warnings only. Test deliveries use their run ID instead, leaving real report records untouched. GitHub history failures stop the check rather than guessing. Caches normally expire after seven days without access and can be evicted under storage pressure; the monitor only checks the most recent due weekday. Slack delivery and cache storage are not transactional: after a timeout or failed cache save, reconcile Slack before manually retrying; a later automatic check can duplicate an ambiguously delivered warning or one whose cache was removed.

Run `node --test scripts/wrap-up-monitor.test.mjs` for offline checks. Dispatch **Daily wrap-up monitor** on main with `mode=test` for one labelled Slack test; rerun that same run to verify deduplication. `mode=check` checks actual coverage. Only disable the old local missed-report warning after hosted delivery, deduplication and receipt sync have been verified. Keep the local waiting-for-input checker enabled: it still watches local chats and publishes receipts.

If the local sync fails, inspect its `logs/errors.log`, the GitHub CLI login and the repository variable. If hosted delivery fails, inspect the workflow run and the existing Slack webhook secret. No app deployment, database change or new credential is needed.

No guide impact: this is operational monitoring outside the Respovia agent UI.
