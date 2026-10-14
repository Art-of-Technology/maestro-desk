# Widget layout sync validation

Validated 2026-10-08 for Dashboard and Insights widget order and visibility.

## Behavior

- Each account/workspace has separate Dashboard and Insights layouts. Existing
  `user_preferences.dashboard_layout` and `report_layout` columns are reused;
  no migration or dependency is required.
- Loading, saving, reset, explicit legacy import, and offline recovery share the
  existing widget controls. A successful save displays “Layout synced”.
- The last successful save wins for a complete page layout. Saving one page
  preserves the other page, statistic formats, and other preferences.
- Other devices load the saved layout on refresh or sign-in; this is not live
  multi-device collaboration. Pending browser changes retry on refresh,
  reconnect, or Retry. Closing while both browser storage and the API fail
  loses the change; that state explicitly asks the user to keep the page open.
- Old unowned `dash_layout` / `report_layout` values require explicit import.
  New widgets append; retired IDs are filtered out when normalizing a layout.

## Automated checks

- All 60 frontend Bun test command groups from CI passed in separate processes.
- 15 focused frontend tests passed (11 preference sync, 4 widget controls).
  These cover delayed loads/writes, account/workspace switching, pending changes
  across refresh, storage failure, import, drag ordering, hide/show and reset.
- 5 widget API/schema tests passed on migrated PostgreSQL 17. Another 5 existing
  statistic-preference API tests passed alongside them. Tests cover active
  membership, ownership isolation, rejected extra fields, ID validation,
  concurrent page saves, and preservation of unrelated preferences.
- API TypeScript check and high-severity dependency audit passed; no dependency
  vulnerabilities were reported.
- Frontend build, bridge collision check, import audit, all 24 route smokes and
  all 7 ticket detail smokes passed.

## Browser and review evidence

Chrome used the actual native ES modules, event delegation, widget controls and
styles with sample cards and a local HTTP preference fixture. Separate localhost
and 127.0.0.1 origins provided independent browser storage against one fixture
backend. Real authentication and SQL behavior were tested separately above.

Verified explicit import, restored order/visibility across the two origins,
refresh, logout/login, account and workspace isolation, offline refresh and
reconnect, and resetting Dashboard without changing Insights. Browser checking
found a stale Retry button after successful reconnect; clearing the failure flag
and guarding late failed loads fixed it, with regression coverage.

At 390 × 844, the manager had no horizontal overflow, 44 × 44 switch hit areas,
visible keyboard focus, and keyboard-operable switches. No console errors were
reported. Screenshot: `C:/Users/Jodi/respovia-widget-layout-mobile.png` (local
fixture, not a production screenshot).

Code/security review checked authenticated ownership on every query, constant
column selection, bounded strict input schemas, no-store responses, escaped UI
content, stale-session guards, atomic pending receipts, and serialized saves.
No unresolved blocking findings. No production preferences were changed.

The guided-tour text and CI coverage were updated with this feature.
