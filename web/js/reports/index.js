// Workspace-wide Reports; chart preferences remain independent of report data.
import { CURRENT_PAGE } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { pageTabs, INSIGHT_TABS } from '../core/page-tabs.js';
import { downloadCSV } from '../core/csv.js';
import { renderReplyPerformance, safeReportCell } from './reply-performance.js';
import { renderLanguageDetectionFailures } from './language-detection.js';
import { renderWidgetGrid, registerWidgetCatalog } from '../core/widget-shell.js';
import { renderStatView } from '../core/stat-view.js';
import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';

import { STATUS_COLORS, PRIORITY_COLORS, SENTIMENT_COLORS } from '../core/colors.js';

// Timeframe filter — only the Reports page reads or writes this, so it
// stays module-local rather than going to core/state.js.
let REPORT_TF = '30d';
let AI_REPORT = false;

function setReportTF(v) { REPORT_TF = v; renderPage('reports'); }

let reportState = null;
const esc = value => window.escHtml(String(value ?? ''));
const requestKey = () => JSON.stringify([getWorkspaceId(), getJwt(), REPORT_TF, new Date().toISOString().slice(0, 10)]);
function rerender() { if (CURRENT_PAGE === 'reports' && !AI_REPORT) renderPage('reports'); }
function resetReport() { reportState = null; }
window.addEventListener?.('respovia:auth-scope-changed', () => { AI_REPORT = false; resetReport(); });

async function loadReport(key) {
  const state = reportState = { key, data: null, error: null, exporting: false, exportError: null };
  try {
    const data = await apiGet('/api/v1/reports/insights?' + new URLSearchParams({ range: REPORT_TF }));
    if (reportState === state && requestKey() === key) state.data = data;
  } catch {
    if (reportState === state && requestKey() === key) state.error = 'Could not load Reports. Please retry.';
  } finally {
    if (reportState === state && requestKey() === key) rerender();
  }
}

function reportStatus(s) {
  return '<div class="card"><div class="card-title">Status distribution</div>' + renderStatView('r-status', 'Status distribution', ['Category', 'Tickets'], Object.entries(s.byStatus).sort((a,b) => b[1] - a[1]), { choices: ['bar', 'donut', 'table'], colorFor: k => (STATUS_COLORS)[k] || 'var(--cyan)' }) + '</div>';
}

function reportPriority(s) {
  return '<div class="card"><div class="card-title">Priority breakdown</div>' + renderStatView('r-priority', 'Priority breakdown', ['Category', 'Tickets'], ['urgent','high','normal','low'].filter(p => s.byPriority[p]).map(p => [p, s.byPriority[p]]), { choices: ['bar', 'donut', 'table'], colorFor: k => (PRIORITY_COLORS)[k] || 'var(--cyan)' }) + '</div>';
}

function reportCategory(s) {
  return '<div class="card"><div class="card-title">Category volume</div>' + renderStatView('r-category', 'Category volume', ['Category', 'Tickets'], Object.entries(s.byCategory).sort((a,b) => b[1] - a[1]), { choices: ['bar', 'donut', 'table'] }) + '</div>';
}

function reportAgents(s) {
  return '<div class="card"><div class="card-title">Tickets per agent</div>' + renderStatView('r-agents', 'Tickets per agent', ['Agent', 'Tickets'], s.agents.map(a => [a.name, a.n])) + '</div>';
}

function reportCSAT(s) {
  const rows = [5,4,3,2,1].map(n => [n + ' stars', s.csatBuckets[n - 1]]);
  return '<div class="card"><div class="card-title">CSAT</div><p>' + (s.avgCSAT ? s.avgCSAT.toFixed(1) : '—') + ' average · ' + s.csatCount + ' of ' + s.total + ' tickets rated</p>' + renderStatView('r-csat', 'Customer satisfaction ratings', ['Rating', 'Tickets'], rows, { colorFor: () => 'var(--amber)' }) + '</div>';
}

function reportTime(s) {
  const rows = s.timeAgents.map(a => [a.name, a.billable, a.total - a.billable]);
  return '<div class="card"><div class="card-title">Time logged</div><p>' + window.fmtMinutes(s.timeTotal) + ' total · ' + window.fmtMinutes(s.timeBillable) + ' billable</p>' + renderStatView('r-time', 'Time logged by agent', ['Agent', 'Billable', 'Non-billable'], rows, { formatValue: v => Number(v) === 0 ? '0m' : window.fmtMinutes(v) }) + '</div>';
}

function reportSentimentTrend(s) {
  const order = ['angry', 'frustrated', 'neutral', 'positive'];
  const rows = (s.sentimentTrend || []).map(b => [b.start, ...order.map(k => b.counts[k] || 0)]);
  const days = s.sentimentTrend[0]?.days || 1;
  return '<div class="card"><div class="card-title">Sentiment trend</div>' + renderStatView('r-sentiment-trend', 'Sentiment trend', ['Period starting', ...order], rows, { choices: ['line', 'bar', 'table'], colorFor: (_label, i) => SENTIMENT_COLORS[order[i]] }) + '<p class="report-note">Latest customer sentiment by ticket creation date. Each point covers ' + days + (days === 1 ? ' UTC day' : ' UTC days') + ', including periods with no tickets.</p></div>';
}

function reportSentiment(s) {
  // Order angry → frustrated → neutral → positive so the visual flow
  // matches the urgency story (red on the left, green on the right).
  const ORDER = ['angry', 'frustrated', 'neutral', 'positive'];
  const items = ORDER.filter(k => s.bySentiment[k]).map(k => [k, s.bySentiment[k]]);
  const unscored = s.total - (s.sentimentScored || 0);
  const footer = s.total === 0
    ? ''
    : `<div style="margin-top:10px;font-size:11px;color:var(--ink3)">${s.sentimentScored || 0} of ${s.total} tickets have a scored latest customer message${unscored > 0 ? ` · ${unscored} unscored` : ''}</div>`;
  const body = items.length
    ? renderStatView('r-sentiment', 'Customer sentiment', ['Sentiment', 'Tickets'], items, { choices: ['bar', 'donut', 'table'], colorFor: k => SENTIMENT_COLORS[k] || 'var(--ink3)' })
    : '<div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No scored sentiments in this range</div>';
  return `<div class="card"><div class="card-title">Customer sentiment</div>${body}${footer}</div>`;
}

function reportSLA(s) {
  return '<div class="card"><div class="card-title">Recorded SLA status</div>' + renderStatView('r-sla', 'SLA status', ['Status', 'Tickets'], [['On track', s.slaOk], ['Warning', s.slaWarn], ['Breached', s.slaBreach]], { choices: ['bar', 'donut', 'table'], colorFor: k => ({ 'On track': 'var(--green)', Warning: 'var(--amber)', Breached: 'var(--red)' })[k] }) + '<p>' + s.slaCompliance + '% within the recorded SLA window, excluding closed tickets. Open Tickets for live urgency.</p></div>';
}

export const REPORT_WIDGETS = [
  { id:'r-status',    title:'Status breakdown',  render:s => reportStatus(s) },
  { id:'r-sla',       title:'Recorded SLA status', render:s => reportSLA(s) },
  { id:'r-sentiment',       title:'Customer sentiment',render:s => reportSentiment(s) },
  { id:'r-sentiment-trend', title:'Sentiment trend',   render:s => reportSentimentTrend(s) },
  { id:'r-priority',  title:'Priority',          render:s => reportPriority(s) },
  { id:'r-category',  title:'Category',          render:s => reportCategory(s) },
  { id:'r-agents',    title:'Tickets per agent', render:s => reportAgents(s) },
  { id:'r-csat',      title:'CSAT',              render:s => reportCSAT(s) },
  { id:'r-time',      title:'Time logged',       render:s => reportTime(s) },
  { id:'r-language-detection', title:'Language detection failures', render:() => renderLanguageDetectionFailures(REPORT_TF) },
];

export const DEFAULT_REPORT_LAYOUT = { order: REPORT_WIDGETS.map(w => w.id), hidden: [], charts: {} };

async function exportReport() {
  const state = reportState;
  if (!getJwt() || !state?.data || state.key !== requestKey() || state.exporting) return;
  state.exporting = true;
  state.exportError = null;
  rerender();
  try {
    const { period } = state.data;
    const data = await apiGet('/api/v1/reports/insights?' + new URLSearchParams({ range: period.range, end: period.end, export: '1' }));
    if (reportState !== state || state.key !== requestKey()) return;
    const headers = ['ID','Subject','Status','Priority','Category','Agent','Created','Updated','Recorded SLA','CSAT','Sentiment','Time logged (minutes)','Time billable (minutes)'];
    const rows = data.tickets.map(t => [t.id, t.subject, t.status, t.priority, t.category, t.agent, t.created, t.updated, t.sla, t.csat, t.sentiment, t.timeTotal, t.timeBillable].map(safeReportCell));
    downloadCSV(headers, rows, 'tickets-' + period.range + '-' + period.end.slice(0,10) + '.csv');
  } catch (error) {
    if (reportState === state && state.key === requestKey()) state.exportError = error.status === 422 ? error.message : 'Could not export Reports. Please retry.';
  } finally {
    state.exporting = false;
    if (reportState === state && state.key === requestKey()) rerender();
  }
}

export function renderReports() {
  if (AI_REPORT && window.isAdmin()) return renderReplyPerformance();
  const tf = REPORT_TF;
  const authenticated = !!getJwt();
  if (authenticated && reportState?.key !== requestKey()) void loadReport(requestKey());
  const data = authenticated ? reportState?.data : null;
  const s = data?.report;
  const message = !authenticated ? 'Sign in to see workspace Reports.' : reportState.error || 'Loading workspace totals…';
  return `
    <div class="page insights-report-page">
      <div class="topbar">
        ${pageTabs(INSIGHT_TABS,'reports')}
        <select class="filter-select" aria-label="Reporting period" data-change-action="reports.setTF">
          <option value="7d"  ${tf==='7d'?'selected':''}>Last 7 days</option>
          <option value="30d" ${tf==='30d'?'selected':''}>Last 30 days</option>
          <option value="90d" ${tf==='90d'?'selected':''}>Last 90 days</option>
          <option value="all" ${tf==='all'?'selected':''}>All time</option>
        </select>
        <button class="btn btn-sm" data-action="reports.refresh">Refresh</button>
        <button class="btn btn-sm" data-action="reports.export" ${!s || reportState.exporting ? 'disabled' : ''}>${reportState?.exporting ? 'Exporting…' : 'Export CSV'}</button>
        ${window.isAdmin() ? '<button type="button" class="btn btn-sm" data-action="reports.openAi">AI reply performance</button>' : ''}
      </div>
      ${!s ? `<p class="report-note" role="${reportState?.error ? 'alert' : 'status'}">${esc(message)}</p>` : `
      ${reportState.exportError ? `<p class="report-note" role="alert">${esc(reportState.exportError)}</p>` : ''}
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${s.total}</div><div class="kpi-l">Total tickets</div></div>
        <div class="kpi"><div class="kpi-n c-green">${s.resolutionRate}%</div><div class="kpi-l">Resolved</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${s.avgCSAT?s.avgCSAT.toFixed(1):'—'}</div><div class="kpi-l">Avg CSAT</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${s.slaCompliance}%</div><div class="kpi-l">Recorded SLA compliance</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${window.fmtMinutes(s.timeTotal)}</div><div class="kpi-l">Time logged</div></div>
      </div>
      <div class="page-scroll">
        <p class="report-note">Tickets created ${data.period.start ? 'from ' + esc(data.period.start.slice(0, 10)) : 'at any time'} before ${esc(new Date(data.period.end).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }))} UTC. Ranges include today and use UTC. Deleted and merged tickets are excluded.</p>
        <p class="report-note">Current status, latest ratings and all logged time on those tickets. Resolved and SLA percentages exclude closed tickets. Export uses the same dates with current values when downloaded.</p>
        ${renderWidgetGrid('report', 'report-grid', REPORT_WIDGETS, s)}
      </div>`}
    </div>`;
}

registerActions({
  'reports.refresh': () => { resetReport(); rerender(); },
  'reports.export': () => exportReport(),
  'reports.openAi': () => { AI_REPORT=true;renderPage('reports'); },
  'reports.closeAi': () => { AI_REPORT=false;renderPage('reports'); },
});

registerWidgetCatalog('report', REPORT_WIDGETS, DEFAULT_REPORT_LAYOUT);

registerChangeActions({
  'reports.setTF': (ds, el) => setReportTF(el.value),
});
