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
for (const _t of TICKETS) {
  try {
    globalThis.__openTicket(_t.id);
    console.log(`  openTicket('${_t.id}') [${_t.status}] OK`);
  } catch (e) {
    _failed++;
    console.error(`  openTicket('${_t.id}') FAILED: ${e.message}`);
  }
}

if (_failed > 0) {
  console.error(`\n${_failed}/${TICKETS.length} ticket detail renders failed`);
  process.exit(1);
}
console.log(`\nALL ${TICKETS.length} ticket details rendered without throwing.`);
