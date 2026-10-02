# Hosted features and fixes report

The Daily features and fixes workflow is scheduled for 17:30 Monday–Friday, Europe/London. GitHub may delay a scheduled start. It remains a no-op until repository variable `HOSTED_WRAP_UP_ENABLED` is exactly `true`; the laptop report remains the active sender during setup.

The workflow lists merged PRs and direct main-branch commits since the last confirmed report, using GitHub titles and links only. No AI service, API key or OpenAI credits are used. Explicit conventional `feat:` and `fix:` prefixes (including scopes and breaking-change markers) determine the feature/fix groups; all other titles appear under Other changes. No changes are silently omitted. Titles are flattened, escaped and shortened to 180 characters; the original title remains available at its link. Pagination and commit deduplication preserve catch-up coverage. Incomplete histories or reports exceeding 12,000 characters fail before posting or advancing coverage. Reports describe merges, not deployment status.

## Activation

1. Confirm the existing `SLACK_DEPLOY_WEBHOOK_URL` is configured. The report uses GitHub Actions and Slack only; no AI key is needed.
2. Ensure the laptop's confirmed receipt has synced to `CODEX_WRAP_UP_RECEIPT`. Dispatch `mode=init` on main to seed `wrap-up-state.json` on the dedicated `codex-wrap-up-state` branch. Existing state is never overwritten by initialization. Do this close to cutover, after the last laptop report.
3. Dispatch `mode=preview` and inspect the `wrap-up-preview` artifact. This formats GitHub titles but does not post or advance coverage. Preview artifacts are not delivery records.
4. Dispatch `mode=test`. It uses the same formatting, durable intent and Slack delivery path, clearly labels the message as a test, and leaves report coverage unchanged. Rerun that same workflow run and confirm `already-posted`. Check Slack directly.
5. Before the next 17:30 run, disable only Windows task `Jodi Codex Weekday Wrap-up`, then set `HOSTED_WRAP_UP_ENABLED=true`. Keep `Jodi Codex Waiting Alerts` enabled for chat alerts. It may still publish the old receipt; the hosted monitor ignores that variable after cutover and reads the dedicated state branch instead.
6. Verify the first scheduled report and the 18:35 monitor. If activation is delayed across another laptop report, reconcile the starting state to the latest confirmed Slack footer before enabling hosted sending; do not knowingly replay already reported work.

## Delivery safety and recovery

`contents: write` is needed solely for the dedicated state branch. Each write uses the previous file SHA, and report runs share one non-cancelling concurrency group. The state file stores timestamps, fixed channel ID, workflow IDs and delivery status, not report text or secrets. Its commits use `[skip ci]` and never modify main.

Before posting, the workflow commits a `pending` intent. After Slack acknowledges `ok`, it records the new coverage and clears pending. A webhook acknowledgement is the delivery evidence; incoming webhooks do not return a Slack message timestamp. The monitor accepts this explicit hosted receipt without inventing one.

If a send times out or the final state write fails, pending remains and subsequent sends stop. Do not clear it or rerun blindly. Read Slack and match the exact coverage footer from `pending.cutoff`. If the report exists, record its confirmed receipt/lastDate and clear pending. If delivery definitely did not occur, clear pending without advancing coverage. For a test delivery, update only lastTestRun and clear pending. Use a SHA-checked contents update on the dedicated branch, preserving unrelated fields. The next normal report includes any unreported gap. Source/formatting failures happen before intent and do not change coverage.

Never delete the state branch/file to fix an error. GitHub cache or artifact eviction cannot remove report coverage. The separate missed-report warning still uses its own cache-based deduplication and documented limits.

Run `node --test scripts/daily-wrap-up.test.mjs scripts/wrap-up-monitor.test.mjs` for offline coverage, including source pagination, title grouping and preview without AI, mention escaping, duplicate suppression, uncertain delivery, state persistence and disabled/weekday scheduling.

No guide impact: operational automation only.
