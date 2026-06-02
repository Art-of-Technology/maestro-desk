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
// (escHtml / escAttr / renderPage / isAdmin / fmtMinutes) and loading every
// module — and re-exposes openTicket so detail-smoke-suffix.js can render real
// tickets. Build + concat recipe is documented in detail-smoke-suffix.js.
import '../js/app.js';
import { openTicket } from '../js/tickets/detail.js';

globalThis.__openTicket = openTicket;
