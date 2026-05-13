// ─── State (inline-handler surface) ──────────────────────────────────────────
// Module-scope state read or written by inline HTML attribute handlers
// (e.g. `onchange="FILTER_CATEGORY=this.value;renderPage('tickets')"`).
//
// Lives in a classic <script src> so its top-level `let`/`const` bindings
// land in the global lexical environment. That env is visible to:
//   • inline event handler functions (their scope chain ends at globalEnv)
//   • ES modules (identifier lookup walks module env → globalEnv)
//
// Result: inline handlers can read/write these names directly; app.js (a
// module) reads/writes them via plain identifier reference, no window.X
// prefix needed. The bindings stay in sync because there's only one of them.
//
// Only the inline-handler-visible slice of state migrated here. The rest
// of app.js's module-scope state stays where it is for now.
let CURRENT_PAGE = 'dashboard';
let FILTER_CATEGORY = 'all';
let FILTER_PRIORITY = 'all';
let FILTER_AGENT = 'all';
let FILTER_QUERY = '';
let AGENT_SELECTED = null;
let CUSTOMER_SELECTED = null;
let KB_SELECTED = null;
let TAG_SELECTED = null;
let INBOX_SELECTED_ID = null;
let SETTINGS_TAB = 'profile';
let LAYOUTS_TAB = 'ticket';
let ACT_FILTER_ENTITY = 'all';
let ACT_FILTER_TYPE = 'all';
let AR_FILTER = 'all';
let CF_FILTER_ENTITY = 'all';
let CH_FILTER = 'all';
let CSAT_FILTER_AGENT = 'all';
let CSAT_FILTER_SCORE = 'all';
let INBOX_FILTER_CHANNEL = 'all';
let INBOX_FILTER_STATUS  = 'new';
let MACRO_FILTER_QUERY = '';
let SEARCH_PAGE_FILTER = 'all';
let SLA_FILTER = 'all';
let TPL_FILTER_CAT = 'all';
let TT_FILTER_CAT = 'all';
const BASE_COLUMNS = [
  {id:'id',label:'Customer ID',fixed:true},
  {id:'name',label:'Name',fixed:true},
  {id:'username',label:'Username',fixed:false},
  {id:'brand',label:'Brand',fixed:false},
  {id:'vip',label:'VIP',fixed:false},
  {id:'jurisdiction',label:'Jurisdiction',fixed:false},
  {id:'consent',label:'Consent',fixed:false},
  {id:'kyc',label:'KYC',fixed:false},
];
let CUST_COLUMNS = BASE_COLUMNS.map(c=>({...c,visible:true}));
let CUST_DRAG_COL = null;
