// Appended AFTER the detail-smoke-entry bundle. The bundle has executed: the
// window bridge is populated and the entry re-exposed globalThis.__openTicket
// and globalThis.__TICKETS (TICKETS now lives in the data.js ES module, bundled
// rather than concatenated as a classic-script global).
//
// Run:
//   bun build scripts/detail-smoke-entry.js > scripts/detail-entry.bundled.js
//   cat scripts/bridge-smoke-shim-prefix.js \
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
// Aliased (not `const TICKETS`) so it doesn't collide with the bundle's own
// top-level `var TICKETS` from the data.js module concatenated above.
const DEMO_TICKETS = globalThis.__TICKETS;
if (!Array.isArray(DEMO_TICKETS) || DEMO_TICKETS.length === 0) {
  console.error('TICKETS not exposed — entry bundle broken');
  process.exit(1);
}
console.log(`init OK — bridge populated, ${DEMO_TICKETS.length} demo tickets`);

let _failed = 0;
let _firstStack = null;
for (const _t of DEMO_TICKETS) {
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
  console.error(`\n${_failed}/${DEMO_TICKETS.length} ticket detail renders failed`);
  // Print one stack (they're usually the same dead-reference) so the failing
  // file:line is right there — e.g. the #273 bug pointed at detail.js:598.
  console.error(`\nFirst failure:\n${_firstStack}`);
  process.exit(1);
}
console.log(`\nALL ${DEMO_TICKETS.length} ticket details rendered without throwing.`);
