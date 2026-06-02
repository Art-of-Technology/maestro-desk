// Appended AFTER the detail-smoke-entry bundle. The bundle has executed: the
// window bridge is populated and globalThis.__openTicket is set. state.js +
// data.js are concatenated AHEAD of the bundle, so TICKETS / CUSTOMERS /
// CURRENT_TICKET are script-scope visible to the bundled render code — the same
// mechanism the bridge smoke relies on (see bridge-smoke-shim-prefix.js).
//
// Run:
//   bun build scripts/detail-smoke-entry.js > scripts/detail-entry.bundled.js
//   cat scripts/bridge-smoke-shim-prefix.js js/core/state.js js/core/data.js \
//       scripts/detail-entry.bundled.js scripts/detail-smoke-suffix.js > scripts/detail-smoke.js
//   bun scripts/detail-smoke.js
//
// Renders every demo ticket through openTicket() to catch missing-global /
// dead-reference bugs in the detail render that the route-only smoke cannot
// reach. Demo tickets have no `_uuid`, so openTicket renders synchronously from
// local data — no backend fetch, no presence heartbeat.

if (typeof globalThis.__openTicket !== 'function') {
  console.error('openTicket was not exposed — entry bundle broken');
  process.exit(1);
}
if (typeof TICKETS === 'undefined' || !Array.isArray(TICKETS) || TICKETS.length === 0) {
  console.error('TICKETS not in scope — state.js/data.js must be concatenated ahead of the bundle');
  process.exit(1);
}
console.log(`init OK — bridge populated, ${TICKETS.length} demo tickets`);

let _failed = 0;
let _firstStack = null;
for (const _t of TICKETS) {
  try {
    globalThis.__openTicket(_t.id);
    console.log(`  openTicket('${_t.id}') [${_t.status}] OK`);
  } catch (e) {
    _failed++;
    if (!_firstStack) _firstStack = e.stack || String(e);
    console.error(`  openTicket('${_t.id}') [${_t.status}] FAILED: ${e.message}`);
  }
}

if (_failed > 0) {
  console.error(`\n${_failed}/${TICKETS.length} ticket detail renders failed`);
  // Print one stack (they're usually the same dead-reference) so the failing
  // file:line is right there — e.g. the #273 bug pointed at detail.js:598.
  console.error(`\nFirst failure:\n${_firstStack}`);
  process.exit(1);
}
console.log(`\nALL ${TICKETS.length} ticket details rendered without throwing.`);
