// Execution-test entry for the ticket-detail render path.
//
// The bridge smoke (bridge-smoke-shim-suffix.js) only calls renderPage() for
// each route — it never opens a ticket, so a bug inside openTicket() or the
// detail render (e.g. a bare reference to a function that left the window
// bridge) sails straight through bun build + the route smoke. That is exactly
// how the isAgentOOO ReferenceError fixed in #273 reached production: detail.js
// referenced `isAgentOOO`/`applyAssignmentRules` as bare globals, they stopped
// being on the bridge when AssignmentRules retired (#255), and no test opened a
// ticket.
//
// This entry imports app.js for its side effects — populating the window bridge
// (escHtml / escAttr / isAdmin / fmtMinutes) and loading every module — and
// re-exposes openTicket so detail-smoke-suffix.js can render real tickets.
// openTicket reaches renderPage through a direct core/router.js import, so this
// path no longer depends on renderPage being on the window bridge. TICKETS now
// lives in the data.js ES module (bundled, not a concatenated global), so it is
// re-exposed here for the suffix. Build + concat recipe is in detail-smoke-suffix.js.
import '../js/app.js';
import { openTicket } from '../js/tickets/detail.js';
import { TICKETS } from '../js/core/data.js';

globalThis.__openTicket = openTicket;
globalThis.__TICKETS = TICKETS;
