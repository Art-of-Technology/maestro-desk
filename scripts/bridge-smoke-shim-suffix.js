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
  'agents', 'kb', 'inbox', 'channels', 'webhooks',
  'tags', 'roles', 'settings', 'help',
  'notifications', 'profile', 'layouts', 'custom-fields',
  'ticket-templates', 'kb-integration', 'business-hours',
  'sla-policies', 'assignment-rules', 'templates', 'macros',
  'config',
];

let _failed = 0;
for (const _r of _routes) {
  try {
    globalThis.__renderPage(_r);
    console.log(`  renderPage('${_r}') OK`);
  } catch (e) {
    _failed++;
    console.error(`  renderPage('${_r}') FAILED: ${e.message}`);
  }
}

if (_failed > 0) {
  console.error(`\n${_failed}/${_routes.length} routes failed`);
  process.exit(1);
}
console.log(`\nALL ${_routes.length} routes rendered without throwing.`);
