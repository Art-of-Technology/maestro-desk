// Appended AFTER the bundle. Bundle has just executed in script scope, so
// state.js declarations are bare-name visible. The route-smoke entry re-exposed
// renderPage as globalThis.__renderPage (it's no longer on the window bridge).
// Exercise every route to catch missing-export / dead-reference bugs.

if (typeof globalThis.__renderPage !== 'function') {
  console.error('renderPage was not exposed — entry bundle broken');
  process.exit(1);
}
console.log('init OK — renderPage exposed');

const _routes = [
  'dashboard', 'tickets', 'reports', 'customers',
  'agents', 'kb', 'channels', 'webhooks',
  'tags', 'roles', 'settings', 'help',
  'notifications', 'profile', 'layouts', 'custom-fields',
  'ticket-templates', 'business-hours',
  'sla', 'assignment-rules', 'templates', 'macros',
  'config', 'sla-breach',
];

// renderPage() falls back to the dashboard on an unknown key rather than
// leaving the previous page on screen. That's right for users, but it means a
// deleted renderer — or a typo'd key in the list above — can no longer make
// this smoke throw: it would report "ALL N routes rendered" while silently
// rendering the dashboard N times. (Exactly that was happening for two
// entries: 'kb-integration', a settings tab that was never a page, and
// 'sla-policies', whose real key is 'sla'.)
//
// So assert what was actually rendered, not what got logged. renderPage sets
// document.body.dataset.currentPage, and on the fallback path the recursive
// call overwrites it with 'dashboard' — so a mismatch IS the failure. Keying
// off the dataset rather than the warning text means the check can't quietly
// stop working if that log line is ever reworded.
const _notRendered = [];

let _failed = 0;
for (const _r of _routes) {
  try {
    globalThis.__renderPage(_r);
    const _landed = document.body.dataset.currentPage;
    if (_landed !== _r) {
      _notRendered.push(`${_r} → landed on '${_landed}'`);
      console.error(`  renderPage('${_r}') DID NOT RENDER — fell back to '${_landed}'`);
    } else {
      console.log(`  renderPage('${_r}') OK`);
    }
  } catch (e) {
    _failed++;
    console.error(`  renderPage('${_r}') FAILED: ${e.message}`);
  }
}

if (_notRendered.length > 0) {
  console.error(`\n${_notRendered.length} route(s) are not registered pages — the smoke was not really exercising them:`);
  for (const m of _notRendered) console.error(`  ${m}`);
  process.exit(1);
}

if (_failed > 0) {
  console.error(`\n${_failed}/${_routes.length} routes failed`);
  process.exit(1);
}
console.log(`\nALL ${_routes.length} routes rendered without throwing.`);
