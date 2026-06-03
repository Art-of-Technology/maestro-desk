// ─── Shared state ────────────────────────────────────────────────────────────
// State that needs to be visible across module boundaries — e.g. CURRENT_TICKET,
// which app.js sets on open and ai/summarize.js reads to decide whether to
// refresh, plus the per-page FILTER_* / *_SELECTED bindings the render code reads.
//
// This is an ES module. Importers read each binding live (an imported binding
// always reflects the latest value), so a module just imports the names it
// needs. Because an imported binding can't be reassigned by the importer, every
// mutable scalar has a setter below (setX); the const collections are mutated
// in place and need none.
export let SESSION = null;
export let CURRENT_PAGE = 'dashboard';
export let CURRENT_TICKET = null;
export const TICKET_SELECTED_IDS = new Set();
export let AI_THINKING = false;
export let COMPOSE_TAB = 'reply';
export let AI_MESSAGES = [];
export let FILTER_CATEGORY = 'all';
export let FILTER_PRIORITY = 'all';
export let FILTER_AGENT = 'all';
export let FILTER_SENTIMENT = 'all';
export let FILTER_QUERY = '';
export let AGENT_SELECTED = null;
export let CUSTOMER_SELECTED = null;
export const CUSTOMER_SELECTED_IDS = new Set();
// Dashboard and Reports layouts — null until app.js hydrates them at
// startup from localStorage. Live here so the widget-shell module and the
// per-page render code (dashboard module + reports renderers in app.js)
// share one binding (widget-shell handlers reassign on reset; reorder
// mutates in-place).
export let DASH_LAYOUT = null;
export let REPORT_LAYOUT = null;
export let KB_SELECTED = null;
export let TAG_SELECTED = null;
export let TAG_FILTER_TYPE = 'all';
export let TAG_QUERY = '';
export const TAG_SELECTED_NAMES = new Set();
export let TAG_SORT_COL = 'count';
export let TAG_SORT_DIR = -1;
export let INBOX_SELECTED_ID = null;
export let WF_SELECTED = null;
export let WF_FILTER = 'all';
export let WF_QUERY = '';
export let NOTIF_PREFS = JSON.parse(localStorage.getItem('notif_prefs') || 'null') || { breach:true, escalated:true, gdpr:true, warn:true, wake:true, mention:true };
if (typeof NOTIF_PREFS.wake === 'undefined') NOTIF_PREFS.wake = true;
if (typeof NOTIF_PREFS.mention === 'undefined') NOTIF_PREFS.mention = true;
export let ROLES_VIEW_AGENTS = null; // role name → show agents-in-role page; null → matrix
export let SETTINGS_TAB = 'profile';
export let LAYOUTS_TAB = 'ticket';
export let ACT_FILTER_ENTITY = 'all';
export let ACT_FILTER_TYPE = 'all';
export let AR_FILTER = 'all';
export let CF_FILTER_ENTITY = 'all';
export let CH_FILTER = 'all';
export let CSAT_FILTER_AGENT = 'all';
export let CSAT_FILTER_SCORE = 'all';
export let INBOX_FILTER_CHANNEL = 'all';
export let INBOX_FILTER_STATUS  = 'new';
export let MACRO_FILTER_QUERY = '';
export let SEARCH_PAGE_FILTER = 'all';
export let SLA_FILTER = 'all';
export let TPL_FILTER_CAT = 'all';
export let TPL_QUERY = '';
export let TT_FILTER_CAT = 'all';
export const BASE_COLUMNS = [
  {id:'id',label:'Customer ID',fixed:true},
  {id:'name',label:'Name',fixed:true},
  {id:'username',label:'Username',fixed:false},
  {id:'brand',label:'Brand',fixed:false},
  {id:'vip',label:'VIP',fixed:false},
  {id:'jurisdiction',label:'Jurisdiction',fixed:false},
  {id:'consent',label:'Consent',fixed:false},
  {id:'kyc',label:'KYC',fixed:false},
];
export let CUST_COLUMNS = BASE_COLUMNS.map(c=>({...c,visible:true}));
export let CUST_DRAG_COL = null;

// ─── Setters ────────────────────────────────────────────────────────────────
// state.js is now an ES module: importers read these bindings live (an imported
// binding reflects the latest value) but cannot assign to them. Mutations go
// through these per-name setters. The const collections (TICKET_SELECTED_IDS,
// CUSTOMER_SELECTED_IDS, TAG_SELECTED_NAMES, BASE_COLUMNS) are mutated in place
// (.add/.clear/.splice) so they need no setter. A few setters carry a "Value"
// suffix where the plain name collides with a feature function (setComposeTab,
// setSettingsTab) that already does more than a bare assignment.
export function setSession(v) { SESSION = v; }
export function setCurrentPage(v) { CURRENT_PAGE = v; }
export function setCurrentTicket(v) { CURRENT_TICKET = v; }
export function setAiThinking(v) { AI_THINKING = v; }
export function setComposeTabValue(v) { COMPOSE_TAB = v; }
export function setAiMessages(v) { AI_MESSAGES = v; }
export function setFilterCategory(v) { FILTER_CATEGORY = v; }
export function setFilterPriority(v) { FILTER_PRIORITY = v; }
export function setFilterAgent(v) { FILTER_AGENT = v; }
export function setFilterSentiment(v) { FILTER_SENTIMENT = v; }
export function setFilterQuery(v) { FILTER_QUERY = v; }
export function setAgentSelected(v) { AGENT_SELECTED = v; }
export function setCustomerSelected(v) { CUSTOMER_SELECTED = v; }
export function setDashLayout(v) { DASH_LAYOUT = v; }
export function setReportLayout(v) { REPORT_LAYOUT = v; }
export function setKbSelected(v) { KB_SELECTED = v; }
export function setTagSelected(v) { TAG_SELECTED = v; }
export function setTagFilterType(v) { TAG_FILTER_TYPE = v; }
export function setTagQuery(v) { TAG_QUERY = v; }
export function setTagSortCol(v) { TAG_SORT_COL = v; }
export function setTagSortDir(v) { TAG_SORT_DIR = v; }
export function setInboxSelectedId(v) { INBOX_SELECTED_ID = v; }
export function setWfSelected(v) { WF_SELECTED = v; }
export function setWfFilter(v) { WF_FILTER = v; }
export function setWfQuery(v) { WF_QUERY = v; }
export function setNotifPrefs(v) { NOTIF_PREFS = v; }
export function setRolesViewAgents(v) { ROLES_VIEW_AGENTS = v; }
export function setSettingsTabValue(v) { SETTINGS_TAB = v; }
export function setLayoutsTab(v) { LAYOUTS_TAB = v; }
export function setActFilterEntity(v) { ACT_FILTER_ENTITY = v; }
export function setActFilterType(v) { ACT_FILTER_TYPE = v; }
export function setArFilter(v) { AR_FILTER = v; }
export function setCfFilterEntity(v) { CF_FILTER_ENTITY = v; }
export function setChFilter(v) { CH_FILTER = v; }
export function setCsatFilterAgent(v) { CSAT_FILTER_AGENT = v; }
export function setCsatFilterScore(v) { CSAT_FILTER_SCORE = v; }
export function setInboxFilterChannel(v) { INBOX_FILTER_CHANNEL = v; }
export function setInboxFilterStatus(v) { INBOX_FILTER_STATUS = v; }
export function setMacroFilterQuery(v) { MACRO_FILTER_QUERY = v; }
export function setSearchPageFilter(v) { SEARCH_PAGE_FILTER = v; }
export function setSlaFilter(v) { SLA_FILTER = v; }
export function setTplFilterCat(v) { TPL_FILTER_CAT = v; }
export function setTplQuery(v) { TPL_QUERY = v; }
export function setTtFilterCat(v) { TT_FILTER_CAT = v; }
export function setCustColumns(v) { CUST_COLUMNS = v; }
export function setCustDragCol(v) { CUST_DRAG_COL = v; }
