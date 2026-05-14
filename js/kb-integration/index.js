// ─── Third-party KB integration ─────────────────────────────────────────────
// Admins point this at their own KB service. The adapter is intentionally
// generic: configure a base URL + path template (with {query} placeholder),
// an optional auth header, and which JSON fields hold the title/body/URL.
// Composer's "AI Reply with KB" action and the ticket sidebar "External KB"
// block both consume the same fetchKbArticles() result.
//
// Exports live bindings: KB_INTEGRATION (config object — mutated in place
// from Settings → Knowledge Base via `KB_INTEGRATION[key] = value`), and
// KB_TICKET_CACHE (the LRU Map). Neither is ever reassigned, so app.js and
// the Settings page see the same live references through their imports.
//
// External reaches (interim, via window): openTicket — still in app.js.
//
// TICKETS comes from data.js; CURRENT_TICKET from state.js (global lex env).

const KB_INTEGRATION_DEFAULTS = {
  enabled: false,
  baseUrl: '',
  searchPath: '/articles?q={query}',
  apiKey: '',
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  resultsField: '',   // dot-path into response, e.g. "data" or "data.items"; blank = root
  idField: 'id',
  titleField: 'title',
  bodyField: 'body',
  urlField: 'url',
  maxResults: 3,
};
export let KB_INTEGRATION = Object.assign({}, KB_INTEGRATION_DEFAULTS, (() => {
  try { return JSON.parse(localStorage.getItem('kb_integration') || '{}') || {}; }
  catch (e) { return {}; }
})());

export function saveKbIntegration() {
  try { localStorage.setItem('kb_integration', JSON.stringify(KB_INTEGRATION)); }
  catch (e) { console.warn('[kb] persist failed', e); }
}

function getByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export async function fetchKbArticles(query) {
  const cfg = KB_INTEGRATION;
  if (!cfg.enabled || !cfg.baseUrl || !cfg.searchPath) return { articles: [], error: 'KB integration is disabled or unconfigured.' };
  if (!query || !query.trim()) return { articles: [], error: 'Empty query.' };
  const url = cfg.baseUrl.replace(/\/$/, '') + cfg.searchPath.replace(/\{query\}/g, encodeURIComponent(query.trim().slice(0, 300)));
  const headers = { 'Accept': 'application/json' };
  if (cfg.apiKey && cfg.authHeader) headers[cfg.authHeader] = (cfg.authPrefix || '') + cfg.apiKey;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { articles: [], error: `KB request failed: HTTP ${res.status}` };
    const data = await res.json();
    let list = getByPath(data, cfg.resultsField);
    if (!Array.isArray(list)) list = Array.isArray(data) ? data : [];
    const max = Math.max(1, Math.min(20, parseInt(cfg.maxResults, 10) || 3));
    const articles = list.slice(0, max).map(item => ({
      id:    getByPath(item, cfg.idField)    ?? '',
      title: getByPath(item, cfg.titleField) ?? '(untitled)',
      body:  getByPath(item, cfg.bodyField)  ?? '',
      url:   getByPath(item, cfg.urlField)   ?? '',
    }));
    return { articles };
  } catch (e) {
    return { articles: [], error: 'KB fetch failed: ' + (e?.message || 'network error') };
  }
}

// LRU cache so a long session viewing many tickets can't grow memory without
// bound. Map.set on an existing key + delete-then-set on read are the standard
// JS LRU pattern (Map preserves insertion order). 50 entries is plenty for
// active triage and trivial in memory.
export const KB_TICKET_CACHE = new Map();
const KB_CACHE_LIMIT  = 50;
function kbCacheSet(id, value) {
  if (KB_TICKET_CACHE.has(id)) KB_TICKET_CACHE.delete(id);
  KB_TICKET_CACHE.set(id, value);
  while (KB_TICKET_CACHE.size > KB_CACHE_LIMIT) {
    const oldest = KB_TICKET_CACHE.keys().next().value;
    KB_TICKET_CACHE.delete(oldest);
  }
}

// Long customer messages produce poor full-text search hits and waste tokens.
// Combine the ticket subject with the first sentence of the customer's first
// message, capped at 200 chars.
export function buildKbQuery(t) {
  const firstCust = (t.msgs || []).find(m => m.r === 'customer');
  const sub = (t.subject || '').trim();
  let body = firstCust ? (firstCust.t || '').trim() : '';
  const stop = body.search(/[.\n!?]/);
  if (stop > 12) body = body.slice(0, stop);
  const q = (sub + ' ' + body).trim();
  return q.slice(0, 200);
}

export async function refreshTicketKbSuggestions(ticketId) {
  const t = TICKETS.find(x => x.id === ticketId);
  if (!t || !KB_INTEGRATION.enabled) return;
  const query = buildKbQuery(t);
  if (!query) return;
  kbCacheSet(ticketId, { loading: true, articles: [], error: null });
  if (CURRENT_TICKET === ticketId) window.openTicket(ticketId);
  const result = await fetchKbArticles(query);
  kbCacheSet(ticketId, { loading: false, articles: result.articles, error: result.error || null });
  if (CURRENT_TICKET === ticketId) window.openTicket(ticketId);
}
