# Hosted features and fixes report

The Daily features and fixes workflow is scheduled for 17:30 Monday–Friday, Europe/London. GitHub may delay a scheduled start. It remains a no-op until repository variable `HOSTED_WRAP_UP_ENABLED` is exactly `true`; the laptop report remains the active sender during setup.

The workflow reads merged PRs and direct main-branch commits since the last confirmed report. It paginates, deduplicates commits associated with PRs, and refuses oversized/incomplete histories. GPT-5 Mini receives only public GitHub titles/descriptions and has no tools, repository credentials or Slack credentials. A strict structured response groups features/fixes; every source must be included or explicitly classified as maintenance/duplicate/not user-visible. Code validates coverage and attaches the verified GitHub links. AI output can still misdescribe a change, so inspect the first preview. Reports never treat a merge as proof of deployment.

## Activation

1. Add a dedicated, funded OpenAI project key as repository Actions secret `WRAP_UP_OPENAI_API_KEY`. Grant access to the Responses API and GPT-5 Mini; do not paste the key into chat or commit it. The existing `SLACK_DEPLOY_WEBHOOK_URL` is reused. No local Codex login is uploaded.
2. Ensure the laptop's confirmed receipt has synced to `CODEX_WRAP_UP_RECEIPT`. Dispatch `mode=init` on main to seed `wrap-up-state.json` on the dedicated `codex-wrap-up-state` branch. Existing state is never overwritten by initialization. Do this close to cutover, after the last laptop report.
3. Dispatch `mode=preview` and inspect the `wrap-up-preview` artifact. This generates AI text but does not post or advance coverage. Preview artifacts are not delivery records.
4. Dispatch `mode=test`. It uses the same AI, durable intent and Slack delivery path, clearly labels the message as a test, and leaves report coverage unchanged. Rerun that same workflow run and confirm `already-posted`. Check Slack directly.
5. Before the next 17:30 run, disable only Windows task `Jodi Codex Weekday Wrap-up`, then set `HOSTED_WRAP_UP_ENABLED=true`. Keep `Jodi Codex Waiting Alerts` enabled for chat alerts. It may still publish the old receipt; the hosted monitor ignores that variable after cutover and reads the dedicated state branch instead.
6. Verify the first scheduled report and the 18:35 monitor. If activation is delayed across another laptop report, reconcile the starting state to the latest confirmed Slack footer before enabling hosted sending; do not knowingly replay already reported work.

## Delivery safety and recovery

`contents: write` is needed solely for the dedicated state branch. Each write uses the previous file SHA, and report runs share one non-cancelling concurrency group. The state file stores timestamps, fixed channel ID, workflow IDs and delivery status, not report text or secrets. Its commits use `[skip ci]` and never modify main.

Before posting, the workflow commits a `pending` intent. After Slack acknowledges `ok`, it records the new coverage and clears pending. A webhook acknowledgement is the delivery evidence; incoming webhooks do not return a Slack message timestamp. The monitor accepts this explicit hosted receipt without inventing one.

If a send times out or the final state write fails, pending remains and subsequent sends stop. Do not clear it or rerun blindly. Read Slack and match the exact coverage footer from `pending.cutoff`. If the report exists, record its confirmed receipt/lastDate and clear pending. If delivery definitely did not occur, clear pending without advancing coverage. For a test delivery, update only lastTestRun and clear pending. Use a SHA-checked contents update on the dedicated branch, preserving unrelated fields. The next normal report includes any unreported gap. Source/AI failures happen before intent and do not change coverage.

Never delete the state branch/file to fix an error. GitHub cache or artifact eviction cannot remove report coverage. The separate missed-report warning still uses its own cache-based deduplication and documented limits.

Run `node --test scripts/daily-wrap-up.test.mjs scripts/wrap-up-monitor.test.mjs` for offline coverage, including source pagination, structured-output failures, mention escaping, duplicate suppression, uncertain delivery, state persistence and disabled/weekday scheduling.

No guide impact: operational automation only.
