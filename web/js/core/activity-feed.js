import { apiGet, getJwt, getWorkspaceId, getWorkspaceSlug } from './api-client.js';
import { formatRoute } from './route-location.js';
import { CURRENT_PAGE, SESSION } from './state.js';
import { renderPage } from './router.js';
import { pageTabs, INSIGHT_TABS } from './page-tabs.js';
import { registerActions, registerChangeActions } from './event-delegation.js';

let feed;
let filters = { kind: 'all', entity: 'all', q: '' };
const kinds = { all: 'All types', agent: 'Assignment', priority: 'Priority', tag: 'Tag', created: 'Created', note: 'Note' };
function context() { return JSON.stringify([getWorkspaceId(), getJwt(), SESSION]); }
function state() {
  const key = context();
  if (!feed || feed.key !== key) {
    filters = { kind: 'all', entity: 'all', q: '' };
    feed = { key, rows: [], loaded: false, loading: false, error: '', cursor: null };
  }
  return feed;
}
async function load(more = false) {
  const current = state();
  if (current.loading) return;
  current.loading = true; current.error = '';
  try {
    const params = new URLSearchParams({ ...filters, limit: '50' });
    if (more && current.cursor) params.set('cursor', current.cursor);
    const res = await apiGet('/api/v1/activity?' + params);
    if (feed !== current || current.key !== context()) return;
    if (!Array.isArray(res.events)) throw new Error('Invalid activity response');
    current.rows = [...new Map((more ? current.rows.concat(res.events) : res.events).map(e => [e.id, e])).values()];
    current.cursor = res.next_cursor; current.loaded = true;
  } catch {
    if (feed === current && current.key === context()) current.error = 'Activity could not be loaded. Please retry.';
  } finally {
    current.loading = false;
    if (feed === current && current.key === context() && CURRENT_PAGE === 'activity') renderPage('activity');
  }
}
function changeFilter(name, value) {
  const current = state();
  filters[name] = value;
  // Replace the request owner so late results from old filters are discarded.
  feed = { ...current, rows: [], loaded: false, loading: false, error: '', cursor: null };
  renderPage('activity');
}

export function showSavedTicketActivity(ticketId) {
  const current = state();
  filters = { kind: 'all', entity: 'ticket', q: '', ticket: ticketId };
  feed = { ...current, rows: [], loaded: false, loading: false, error: '', cursor: null };
  renderPage('activity');
}

export function renderSavedActivity() {
  const current = state();
  if (!current.loaded && !current.loading && !current.error) void load();
  const h = window.escHtml, a = window.escAttr;
  const rows = current.rows.map(e => {
    const workspaceSlug = getWorkspaceSlug();
    const href = formatRoute({ workspaceSlug, workspaceId: getWorkspaceId(),
      page: e.entity === 'ticket' ? 'tickets' : 'customers', entityId: workspaceSlug ? e.entity_id : e.entity_uuid });
    return `<tr><td style="white-space:nowrap">${h(new Date(e.created_at).toLocaleString('en-GB'))}</td>
      <td>${h(kinds[e.kind] || e.kind)}</td><td>${h(e.entity)}</td>
      <td><a href="${a(href)}">${h(e.entity_id)}</a> ${h(e.entity_name)}</td>
      <td style="white-space:pre-wrap;overflow-wrap:anywhere">${h(e.details)}</td><td>${h(e.author_label)}</td></tr>`;
  }).join('');
  return `<div class="page saved-activity-page">
    <div class="topbar">${pageTabs(INSIGHT_TABS, 'activity')}</div>
    <div class="filter-bar" style="flex-wrap:wrap">
      <label>Search <input aria-label="Search activity" class="filter-select" maxlength="200" value="${a(filters.q)}" data-change-action="savedActivity.search" placeholder="Search activity…"></label>
      <label>Entity <select aria-label="Entity" class="filter-select" data-change-action="savedActivity.entity">${Object.entries({ all: 'All entities', ticket: 'Tickets', customer: 'Customers' }).map(([k, v]) => `<option value="${k}" ${filters.entity === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Type <select aria-label="Type" class="filter-select" data-change-action="savedActivity.kind">${Object.entries(kinds).map(([k, v]) => `<option value="${k}" ${filters.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <button class="btn" data-action="savedActivity.refresh" ${current.loading ? 'disabled' : ''}>${current.error ? 'Retry' : 'Refresh'}</button>
      ${filters.ticket ? '<button class="btn" data-action="savedActivity.all">Show all activity</button>' : ''}
    </div>
    <div class="page-scroll">
      <p role="status" aria-live="polite">${current.loading ? 'Loading activity…' : current.error ? h(current.error) : `${current.rows.length} event${current.rows.length === 1 ? '' : 's'} loaded`}</p>
      <div style="overflow-x:auto"><table class="tbl"><thead><tr><th>When</th><th>Type</th><th>Entity</th><th>Reference</th><th>Detail</th><th>Author</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${!current.loading && !current.error && !rows ? '<p class="empty-state">No activity matches these filters.</p>' : ''}
      ${current.cursor ? `<button class="btn" data-action="savedActivity.more" ${current.loading ? 'disabled' : ''}>Load more activity</button>` : ''}
      <p style="font-size:12px;color:var(--ink3)">Saved assignment, priority and tag changes, ticket creation, and customer notes. Earlier changes that were not saved are unavailable.</p>
    </div></div>`;
}
registerActions({
  'savedActivity.all': () => { delete filters.ticket; changeFilter('entity', 'all'); },
  'savedActivity.refresh': () => { void load(); renderPage('activity'); },
  'savedActivity.more': () => { void load(true); renderPage('activity'); },
});
registerChangeActions({
  'savedActivity.search': (_ds, el) => changeFilter('q', el.value.trim()),
  'savedActivity.entity': (_ds, el) => changeFilter('entity', el.value),
  'savedActivity.kind': (_ds, el) => changeFilter('kind', el.value),
});
