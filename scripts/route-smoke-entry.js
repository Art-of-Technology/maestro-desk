// Route smoke entry — bundled by `bun build`, then concatenated after
// state.js / data.js (see bridge-smoke-shim-suffix.js for the full run recipe).
//
// Imports app.js for its side effects — bootstrap, the remaining window bridge,
// and every module load — and re-exposes renderPage so the suffix can drive
// every route. renderPage left the window bridge (callers import it directly
// from core/router.js now), so the smoke reaches it through this explicit
// re-export rather than window.renderPage.
import '../web/js/app.js';
import { renderPage } from '../web/js/core/router.js';
import { setCustomerSelected } from '../web/js/core/state.js';

globalThis.__renderPage = renderPage;
// The customer DETAIL view (renderCustomerDetail + customers/details-card.js)
// only renders with a selection, so the suffix drives it explicitly — the
// bare 'customers' route above is the list page.
globalThis.__setCustomerSelected = setCustomerSelected;
