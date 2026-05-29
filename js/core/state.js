// ─── Shared state ────────────────────────────────────────────────────────────
// State that needs to be visible across module boundaries — either because
// inline HTML attribute handlers touch it directly (e.g.
// `onchange="FILTER_CATEGORY=this.value;renderPage('tickets')"`), or because
// multiple feature modules need to read/write it (e.g. CURRENT_TICKET, which
// app.js sets on open and ai/summarize.js reads to decide whether to refresh).
//
// Lives in a classic <script src> so its top-level `let`/`const` bindings
// land in the global lexical environment. That env is visible to:
//   • inline event handler functions (their scope chain ends at globalEnv)
//   • ES modules (identifier lookup walks module env → globalEnv)
//
// One binding, every world. No `window.X` prefix needed from modules, no
// setter-shims needed from inline handlers, no import declarations needed.
let SESSION = null;
let CURRENT_PAGE = 'dashboard';
let CURRENT_TICKET = null;
const TICKET_SELECTED_IDS = new Set();
let AI_THINKING = false;
let COMPOSE_TAB = 'reply';
let AI_MESSAGES = [];
let FILTER_CATEGORY = 'all';
let FILTER_PRIORITY = 'all';
let FILTER_AGENT = 'all';
let FILTER_SENTIMENT = 'all';
let FILTER_QUERY = '';
let AGENT_SELECTED = null;
let CUSTOMER_SELECTED = null;
const CUSTOMER_SELECTED_IDS = new Set();
// Dashboard and Reports layouts — null until app.js hydrates them at
// startup from localStorage. Live here so the widget-shell module and the
// per-page render code (dashboard module + reports renderers in app.js)
// share one binding (widget-shell handlers reassign on reset; reorder
// mutates in-place).
let DASH_LAYOUT = null;
let REPORT_LAYOUT = null;
let KB_SELECTED = null;
let TAG_SELECTED = null;
let TAG_FILTER_TYPE = 'all';
let TAG_QUERY = '';
const TAG_SELECTED_NAMES = new Set();
let TAG_SORT_COL = 'count';
let TAG_SORT_DIR = -1;
let INBOX_SELECTED_ID = null;
let WF_SELECTED = null;
let WF_FILTER = 'all';
let WF_QUERY = '';
let NOTIF_PREFS = JSON.parse(localStorage.getItem('notif_prefs') || 'null') || { breach:true, escalated:true, gdpr:true, warn:true, wake:true, mention:true };
if (typeof NOTIF_PREFS.wake === 'undefined') NOTIF_PREFS.wake = true;
if (typeof NOTIF_PREFS.mention === 'undefined') NOTIF_PREFS.mention = true;
let ROLES_VIEW_AGENTS = null; // role name → show agents-in-role page; null → matrix
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
let TPL_QUERY = '';
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
