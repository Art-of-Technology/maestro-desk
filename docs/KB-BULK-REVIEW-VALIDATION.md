# Bulk knowledge publishing

## Behavior

- Market/language is derived from the existing `Games · locale` and `Website · locale` import categories. Other categories are Unassigned.
- Market, category, status and search filters intersect. Selection includes only API-backed drafts and clears on filter, session, workspace or loaded-article replacement.
- Confirmation lists the exact count, market breakdown and expandable titles. Sequential PATCH requests reuse the existing article endpoint.
- Successful articles update locally; failures stay selected for retry. Closing the dialog stops after the in-flight request. Session changes stop the queue and discard late local updates.
- UI bulk actions require administrator access. Existing API permissions remain member-level and workspace-scoped, as with individual article edits. Server-side publishing permissions and concurrent-editor conflict detection are separate existing limitations.

## Validation

- App build, API typecheck, import audit, collision check and header synchronization pass.
- All 24 routes and seven ticket detail render smokes pass.
- Article-state, bulk-review and persistence tests pass: filtering, eligible selection, selection invalidation, failures, retries, duplicate confirmations, cancellation and session changes.
- Browser test used local frontend assets in a separate authenticated QA tab, intercepting every API mutation. No live article was published.
- en-ca selected 178 drafts. Simulated batch: 177 successes, one 503 failure; exactly one article remained selected. Changing market and status cleared selection. Individual checkbox selection worked.
- Desktop 1280×900 and tablet 768×1024 screenshots reviewed; tablet has no horizontal overflow. Controls wrap, checkbox labels have 44px height and focus indicators. UI review: 4/5; existing narrow-screen sidebar and shared modal keyboard behavior remain outside this change.
- Code review resolved selection retention after list replacement, late-response navigation, stale result messages after filtering, and scroll/focus loss during checkbox selection.

Screenshots are saved locally in `C:/Users/Jodi/Documents/kb-bulk-*.png`.
