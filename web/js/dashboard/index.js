import { KB_ARTICLES } from '../core/data.js';
import { CURRENT_PAGE, DASH_LAYOUT, SESSION, setAgentSelected, setCustomerSelected, setKbSelected } from '../core/state.js';
import { STATUS_COLORS, PRIORITY_COLORS } from '../core/colors.js';
import { renderWidgetGrid, registerWidgetCatalog } from '../core/widget-shell.js';
import { renderCategoricalChart } from '../core/chart.js';
import { navTo } from '../core/keybindings.js';
import { renderPage } from '../core/router.js';
import { openTicket } from '../tickets/detail.js';
import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { updateOrInsertTicket } from '../core/bootstrap.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { PERIODS, localDate, reportingPeriod } from './period.js';

let selection = 'today';
let customStart = localDate(new Date());
let customEnd = customStart;
let reportState = { key: null, data: null, loading: false, error: null };
const esc = value => window.escHtml(String(value ?? ''));
const cohortNote = 'Tickets created in the selected period; statuses are current.';

export function openAgentFromDash(name) { setAgentSelected(name); navTo('agents'); }
export function invalidateDashboard() { reportState = { key: null, data: null, loading: false, error: null }; }
export function dashboardPeriodChanged() {
  if (!getJwt()) return false;
  try { return reportState.key !== requestKey(reportingPeriod(selection, customStart, customEnd)); }
  catch { return false; } // Leave invalid custom inputs for the user to correct.
}
function rerender() { if (CURRENT_PAGE === 'dashboard') renderPage('dashboard'); }
function requestKey(period) { return JSON.stringify([getWorkspaceId(), getJwt(), period.start, period.end, Intl.DateTimeFormat().resolvedOptions().timeZone]); }
async function loadReport(period, key) {
  const state = reportState = { key, data: null, loading: true, error: null };
  try {
    const query = new URLSearchParams({ start: period.start, end: period.end, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const response = await apiGet(`/api/v1/reports/dashboard?${query}`);
    if (reportState !== state || requestKey(period) !== key) return;
    state.data = response.report;
  } catch (error) {
    if (reportState === state && requestKey(period) === key) state.error = 'Could not load the Dashboard. Please retry.';
  } finally {
    state.loading = false;
    if (reportState === state && requestKey(period) === key) rerender();
  }
}

function card(title, body, note = '', span = 'span-4') {
  return `<div class="card ${span}"><div class="card-title">${esc(title)}</div>${body}${note ? `<p class="report-note">${esc(note)}</p>` : ''}</div>`;
}
function metric(value, label) { return `<div class="kpi"><div class="kpi-n">${esc(value ?? '—')}</div><div class="kpi-l">${esc(label)}</div></div>`; }
function chart(title, data, colors, id, note = cohortNote) {
  const entries = Object.entries(data || {});
  return card(title, entries.length ? renderCategoricalChart(entries, key => colors[key] || 'var(--purple)', DASH_LAYOUT.charts[id] || 'bar') : '<p>No tickets in this period.</p>', note);
}
function ranked(title, rows, note, action) {
  return card(title, rows.length ? rows.slice(0, 5).map(row => `<div class="report-rank"><span>${esc(row.name)}</span><strong>${esc(row.n)}</strong>${action && row.id ? `<button class="btn btn-sm" data-action="${action}" data-id="${window.escAttr(row.id)}">View</button>` : ''}</div>`).join('') : '<p>No tickets in this period.</p>', note);
}
function volumeChart(s) {
  const period = reportingPeriod(selection, customStart, customEnd);
  const counts = new Map(s.volume.map(row => [row.day, Number(row.n)]));
  // A bounded set of calendar buckets keeps custom multi-year ranges readable.
  const from = new Date(`${period.firstDay}T00:00:00`), to = new Date(`${period.lastDay}T00:00:00`);
  const dayCount = Math.round((to - from) / 86400000) + 1;
  const bucketDays = Math.max(1, Math.ceil(dayCount / 31));
  const buckets = [];
  for (let day = new Date(from); day <= to;) {
    const label = localDate(day);
    let count = 0;
    for (let i = 0; i < bucketDays && day <= to; i++, day.setDate(day.getDate() + 1)) count += counts.get(localDate(day)) || 0;
    buckets.push([label, count]);
  }
  return card('Tickets created', renderCategoricalChart(buckets, () => 'var(--purple)', 'bar'), bucketDays === 1 ? 'Daily totals, including days with no tickets.' : `Totals in ${bucketDays}-day groups, labelled by start date.`, 'span-12');
}

export const DASH_WIDGETS = [
  { id: 'today', title: 'Period activity', span: 'span-12', render: s => card('Period activity', `<div class="kpi-bar report-kpis">${metric(s.created, 'Created')}${metric(s.resolved, 'Resolved')}${metric(s.closed, 'Closed')}${metric(s.replies, 'Replies sent')}</div>`, 'Created and replies use their event dates. Resolved and closed count tickets still in that status by their latest resolution or closure date.', 'span-12') },
  { id: 'recent', title: 'Recent tickets', span: 'span-8', render: s => card('Recent tickets created', s.recent.length ? s.recent.map(t => `<button class="btn report-ticket" data-action="dash.openReportTicket" data-id="${window.escAttr(t.id)}"><span>${esc(t.display_id)} · ${esc(t.subject)}</span><span>${esc(t.status_key)}</span></button>`).join('') : '<p>No tickets created in this period.</p>', cohortNote, 'span-8') },
  { id: 'status', title: 'Current status', span: 'span-4', charts: ['bar','donut','list'], render: s => chart('Current status', s.byStatus, STATUS_COLORS, 'status') },
  { id: 'priority', title: 'Priority', span: 'span-4', charts: ['bar','donut','list'], render: s => chart('Priority', s.byPriority, PRIORITY_COLORS, 'priority') },
  { id: 'sla', title: 'Recorded SLA status', span: 'span-4', charts: ['bar','donut','list'], render: s => chart('Recorded SLA status', s.bySla, {ok:'var(--green)',warn:'var(--amber)',breach:'var(--red)'}, 'sla', 'Latest stored SLA state of unfinished tickets created in this period. Open Tickets for the live urgency queue.') },
  { id: 'volume', title: 'Volume trend', span: 'span-12', render: volumeChart },
  { id: 'csat', title: 'Customer satisfaction', span: 'span-4', render: s => card('Customer satisfaction', metric(s.avgCSAT == null ? '—' : Number(s.avgCSAT).toFixed(1), 'Average rating'), `${s.csatCount} ratings submitted in the selected period.`) },
  { id: 'agent-load', title: 'Agent load', span: 'span-8', render: s => ranked('Outstanding by agent', s.agents, cohortNote) },
  { id: 'personal', title: 'My queue', span: 'span-4', render: s => card('Your outstanding tickets', metric(s.mine, 'Outstanding'), 'Assigned to you, created in the selected period, and still unfinished.') },
  { id: 'ai-tags', title: 'AI tag suggestions', span: 'span-4', render: s => card('AI tag suggestions', metric(s.aiTags, 'Awaiting review'), 'Unreviewed suggestions on tickets created in the selected period.') },
  { id: 'kb', title: 'Knowledge base', span: 'span-4', render: () => card('Knowledge base', KB_ARTICLES.slice(0, 4).map(a => `<button class="btn report-ticket" data-action="dash.openKB" data-id="${window.escAttr(a.id)}">${esc(a.title)}</button>`).join('') || '<p>No articles.</p>', 'Current articles; the reporting period does not apply.') },
  { id: 'top-customers', title: 'Top customers', span: 'span-8', render: s => ranked('Top customers', s.customers, 'Tickets created in the selected period.', 'dash.openCustomer') },
];
export const DEFAULT_DASH_LAYOUT = { order: DASH_WIDGETS.map(w => w.id), hidden: [], charts: {} };

export function renderDashboard() {
  let period, validation;
  try { period = reportingPeriod(selection, customStart, customEnd); } catch (e) { validation = e.message; }
  const authenticated = !!getJwt();
  if (authenticated && period) {
    const key = requestKey(period);
    if (reportState.key !== key) void loadReport(period, key);
  }
  const data = authenticated && period ? reportState.data : null;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `<div class="page dashboard-report-page">
    <div class="topbar"><div class="tb-title">Dashboard${SESSION?.name ? ` · ${esc(SESSION.name.split(' ')[0])}` : ''}</div>
      <button class="btn btn-sm" data-action="dash.refresh">Refresh</button></div>
    <div class="filter-bar report-period">
      <label>Reporting period <select class="filter-select" data-change-action="dash.period">${PERIODS.map(([key,label]) => `<option value="${key}" ${selection === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      ${selection === 'custom' ? `<label>From <input class="filter-select" type="date" value="${window.escAttr(customStart)}" data-change-action="dash.from"></label><label>To <input class="filter-select" type="date" value="${window.escAttr(customEnd)}" data-change-action="dash.to"></label>` : ''}
      <span>${period ? `${esc(period.firstDay)} to ${esc(period.lastDay)} · ` : ''}${esc(timezone)} · Weeks start Monday</span>
    </div>
    ${validation ? `<p role="alert" class="report-note">${esc(validation)}</p>` : !authenticated ? '<p class="report-note">Sign in to see date-based workspace reporting.</p>' : reportState.error ? `<p role="alert" class="report-note">${esc(reportState.error)} <button class="btn" data-action="dash.refresh">Retry</button></p>` : !data ? '<p role="status" class="report-note">Loading totals for this period…</p>' : `
      <div class="kpi-bar report-kpis">${metric(data.created, 'Created')}${metric(data.resolved, 'Resolved')}${metric(data.closed, 'Closed')}${metric(data.replies, 'Replies sent')}</div>
      <div class="page-scroll"><p class="report-note">Counts use creation, latest resolution, latest closure, or reply dates. Resolved and closed totals include tickets still in that status. Deleted and merged tickets are excluded.</p>${renderWidgetGrid('dash', 'dash-grid-12', DASH_WIDGETS, DASH_LAYOUT, data)}</div>`}
    </div>`;
}
registerWidgetCatalog('dash', DASH_WIDGETS, DEFAULT_DASH_LAYOUT);
registerActions({
  'dash.refresh': () => { invalidateDashboard(); rerender(); },
  'dash.nav': ds => navTo(ds.page),
  'dash.openTicket': ds => openTicket(ds.id),
  'dash.openReportTicket': async ds => {
    const ws = getWorkspaceId(), jwt = getJwt();
    try {
      const response = await apiGet(`/api/v1/tickets/${encodeURIComponent(ds.id)}`);
      if (ws !== getWorkspaceId() || jwt !== getJwt()) return;
      updateOrInsertTicket(response.ticket);
      openTicket(response.ticket.display_id);
    } catch { if (ws === getWorkspaceId() && jwt === getJwt()) { reportState.error = 'Could not open that ticket. Please refresh and retry.'; rerender(); } }
  },
  'dash.openAgent': ds => openAgentFromDash(ds.name),
  'dash.openKB': ds => { setKbSelected(ds.id); navTo('kb'); },
  'dash.openCustomer': ds => { setCustomerSelected(ds.id); navTo('customers'); },
});
registerChangeActions({
  'dash.period': (ds, el) => { selection = el.value; rerender(); },
  'dash.from': (ds, el) => { customStart = el.value; rerender(); },
  'dash.to': (ds, el) => { customEnd = el.value; rerender(); },
});
