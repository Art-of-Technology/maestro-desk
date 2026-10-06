// ─── Reports ─────────────────────────────────────────────────────────────────
// Reports page: KPI bar, timeframe selector, CSV export, and the 7 widget
// tile renderers (status, priority, category, agents, CSAT, time logged,
// SLA). REPORT_WIDGETS and DEFAULT_REPORT_LAYOUT live here too — they're
// imported by app.js for the startup layout-hydration block alongside
// DASH_WIDGETS / DEFAULT_DASH_LAYOUT.
//
// Click + change handlers route through core/event-delegation.js. No
// inline `on*=` references remain. No external module reaches into
// this module's window-bridged functions — the only external consumer
// (dashboard/index.js) uses a direct ES import for computeReportStats.
//
// External reaches (interim, via window): escHtml, fmtMinutes — still in
// app.js.

import { TICKETS } from '../core/data.js';
import { REPORT_LAYOUT } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { pageTabs, INSIGHT_TABS } from '../core/page-tabs.js';
import { downloadCSV } from '../core/csv.js';
import { renderReplyPerformance } from './reply-performance.js';
import { renderLanguageDetectionFailures } from './language-detection.js';
import { renderWidgetGrid, registerWidgetCatalog } from '../core/widget-shell.js';
import { renderStatView } from '../core/stat-view.js';
import { ticketTotalMinutes, ticketBillableMinutes } from '../tickets/time-tracking.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';

import { STATUS_COLORS, PRIORITY_COLORS, SENTIMENT_COLORS } from '../core/colors.js';

// Timeframe filter — only the Reports page reads or writes this, so it
// stays module-local rather than going to core/state.js.
let REPORT_TF = '30d';
let AI_REPORT = false;

function setReportTF(v) { REPORT_TF = v; renderPage('reports'); }

function getReportTickets() {
  if (REPORT_TF === 'all') return TICKETS.slice();
  const days = REPORT_TF === '7d' ? 7 : REPORT_TF === '30d' ? 30 : 90;
  const dates = TICKETS.map(t => new Date(t.created)).filter(d => !isNaN(d)).sort((a,b) => b - a);
  const now = dates[0] || new Date();
  const cutoff = new Date(now); cutoff.setDate(now.getDate() - days);
  return TICKETS.filter(t => new Date(t.created) >= cutoff);
}

export function computeReportStats(tickets) {
  const byStatus = {}, byPriority = {}, byCategory = {}, byAgent = {}, bySentiment = {};
  const csatScores = [];
  const timeByAgent = {};
  let slaOk = 0, slaWarn = 0, slaBreach = 0;
  let timeTotal = 0, timeBillable = 0;
  let sentimentScored = 0;
  for (const t of tickets) {
    byStatus[t.status]     = (byStatus[t.status]     ||0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] ||0) + 1;
    byCategory[t.category] = (byCategory[t.category] ||0) + 1;
    byAgent[t.agent]       = (byAgent[t.agent]       ||0) + 1;
    if (t.sentiment) {
      bySentiment[t.sentiment] = (bySentiment[t.sentiment] || 0) + 1;
      sentimentScored++;
    }
    if (t.csat) csatScores.push(t.csat);
    if      (t.status !== 'closed' && t.sla === 'ok')     slaOk++;
    else if (t.status !== 'closed' && t.sla === 'warn')   slaWarn++;
    else if (t.status !== 'closed' && t.sla === 'breach') slaBreach++;
    (t.timeEntries || []).forEach(e => {
      timeTotal += e.minutes || 0;
      if (e.billable !== false) timeBillable += e.minutes || 0;
      if (!timeByAgent[e.agent]) timeByAgent[e.agent] = { total: 0, billable: 0 };
      timeByAgent[e.agent].total += e.minutes || 0;
      if (e.billable !== false) timeByAgent[e.agent].billable += e.minutes || 0;
    });
  }
  const total = tickets.length;
  const resolved = byStatus.resolved || 0;
  const eligible = total - (byStatus.closed || 0);
  const resolutionRate = eligible ? Math.round(resolved/eligible*100) : 0;
  const avgCSAT = csatScores.length ? csatScores.reduce((a,b)=>a+b,0)/csatScores.length : 0;
  const slaCompliance = eligible ? Math.round((slaOk + slaWarn)/eligible*100) : 0;
  return { total, byStatus, byPriority, byCategory, byAgent, bySentiment, sentimentScored, csatScores, csatCount:csatScores.length, avgCSAT, slaOk, slaWarn, slaBreach, slaCompliance, resolved, resolutionRate, timeTotal, timeBillable, timeByAgent };
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
  return '<div class="card"><div class="card-title">Tickets per agent</div>' + renderStatView('r-agents', 'Tickets per agent', ['Agent', 'Tickets'], Object.entries(s.byAgent).sort((a,b) => b[1] - a[1])) + '</div>';
}

function reportCSAT(s) {
  const rows = [5,4,3,2,1].map(n => [n + ' stars', s.csatScores.filter(x => x === n).length]);
  return '<div class="card"><div class="card-title">CSAT</div><p>' + (s.avgCSAT ? s.avgCSAT.toFixed(1) : '—') + ' average · ' + s.csatCount + ' of ' + s.total + ' tickets rated</p>' + renderStatView('r-csat', 'Customer satisfaction ratings', ['Rating', 'Tickets'], rows, { colorFor: () => 'var(--amber)' }) + '</div>';
}

function reportTime(s) {
  const rows = Object.entries(s.timeByAgent || {}).sort((a,b) => b[1].total - a[1].total).map(([name, v]) => [name || 'Unassigned', v.billable, v.total - v.billable]);
  return '<div class="card"><div class="card-title">Time logged</div><p>' + window.fmtMinutes(s.timeTotal) + ' total · ' + window.fmtMinutes(s.timeBillable) + ' billable</p>' + renderStatView('r-time', 'Time logged by agent', ['Agent', 'Billable', 'Non-billable'], rows, { formatValue: v => Number(v) === 0 ? '0m' : window.fmtMinutes(v) }) + '</div>';
}

// Bucket tickets into time slots for the sentiment trend widget.
// Granularity ramps with the timeframe so each chart shows ~7–30 bars,
// readable at the widget's normal grid width without horizontal scroll.
//
// Buckets are right-anchored to "now" so the rightmost bar is always
// the current period. We use t.created for bucketing rather than the
// latest_customer_message_at — close enough for trend-shape purposes
// and avoids threading a second timestamp through the SPA. CSV export
// is the path for precise correlation.
function buildSentimentTrend(tickets, tf) {
  const now = new Date();
  const buckets = [];
  const pad2 = (n) => String(n).padStart(2, '0');
  const yyMM = (d) => `${pad2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
  const mmDD = (d) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (tf === '7d' || tf === '30d') {
    const days = tf === '7d' ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - i);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      const label = (tf === '7d' || i % 5 === 0) ? mmDD(start) : '';
      buckets.push({ label, start, end });
    }
  } else if (tf === '90d') {
    for (let i = 12; i >= 0; i--) {
      const end = new Date(now); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() - i * 7 + 1);
      const start = new Date(end); start.setDate(start.getDate() - 7);
      buckets.push({ label: mmDD(start), start, end });
    }
  } else {
    // 'all' → monthly, last 12 months
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end   = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ label: yyMM(start), start, end });
    }
  }
  for (const b of buckets) b.counts = { angry: 0, frustrated: 0, neutral: 0, positive: 0 };
  for (const t of tickets) {
    if (!t.sentiment) continue;
    const c = new Date(t.created);
    if (isNaN(c.getTime())) continue;
    for (const b of buckets) {
      if (c >= b.start && c < b.end) { b.counts[t.sentiment]++; break; }
    }
  }
  return buckets;
}

function reportSentimentTrend(s) {
  const order = ['angry', 'frustrated', 'neutral', 'positive'];
  const rows = (s.sentimentTrend || []).map(b => [b.start.toLocaleDateString('en-CA'), ...order.map(k => b.counts[k] || 0)]);
  return '<div class="card"><div class="card-title">Sentiment trend</div>' + renderStatView('r-sentiment-trend', 'Sentiment trend', ['Period starting', ...order], rows, { choices: ['line', 'bar', 'table'], colorFor: (_label, i) => SENTIMENT_COLORS[order[i]] }) + '</div>';
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
  return '<div class="card"><div class="card-title">SLA</div>' + renderStatView('r-sla', 'SLA status', ['Status', 'Tickets'], [['On track', s.slaOk], ['Warning', s.slaWarn], ['Breached', s.slaBreach]], { choices: ['bar', 'donut', 'table'], colorFor: k => ({ 'On track': 'var(--green)', Warning: 'var(--amber)', Breached: 'var(--red)' })[k] }) + '<p>' + s.slaCompliance + '% of tickets are within SLA window</p></div>';
}

export const REPORT_WIDGETS = [
  { id:'r-status',    title:'Status breakdown',  render:s => reportStatus(s) },
  { id:'r-sla',       title:'SLA',               render:s => reportSLA(s) },
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

function exportReport() {
  const tickets = getReportTickets();
  const headers = ['ID','Subject','Status','Priority','Category','Agent','Created','Updated','SLA','CSAT','Sentiment','Time logged','Time billable'];
  const rows = tickets.map(t => [t.id, t.subject, t.status, t.priority, t.category, t.agent, t.created, t.updated, t.sla, t.csat ?? '', t.sentiment ?? '', window.fmtMinutes(ticketTotalMinutes(t)), window.fmtMinutes(ticketBillableMinutes(t))]);
  downloadCSV(headers, rows, `tickets-${REPORT_TF}-${new Date().toISOString().slice(0,10)}.csv`);
}

export function renderReports() {
  if (AI_REPORT && window.isAdmin()) return renderReplyPerformance();
  const tf = REPORT_TF;
  const tickets = getReportTickets();
  const s = computeReportStats(tickets);
  // Trend buckets need the raw ticket list + timeframe, so we attach
  // them here rather than expanding computeReportStats (which is also
  // called from the dashboard, which doesn't need the trend).
  s.sentimentTrend = buildSentimentTrend(tickets, tf);
  return `
    <div class="page">
      <div class="topbar">
        ${pageTabs(INSIGHT_TABS,'reports')}
        <select class="filter-select" data-change-action="reports.setTF">
          <option value="7d"  ${tf==='7d'?'selected':''}>Last 7 days</option>
          <option value="30d" ${tf==='30d'?'selected':''}>Last 30 days</option>
          <option value="90d" ${tf==='90d'?'selected':''}>Last 90 days</option>
          <option value="all" ${tf==='all'?'selected':''}>All time</option>
        </select>
        <button class="btn btn-sm" data-action="reports.export">Export CSV</button>
        ${window.isAdmin() ? '<button type="button" class="btn btn-sm" data-action="reports.openAi">AI reply performance</button>' : ''}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${s.total}</div><div class="kpi-l">Total tickets</div></div>
        <div class="kpi"><div class="kpi-n c-green">${s.resolutionRate}%</div><div class="kpi-l">Resolved</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${s.avgCSAT?s.avgCSAT.toFixed(1):'—'}</div><div class="kpi-l">Avg CSAT</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${s.slaCompliance}%</div><div class="kpi-l">SLA compliance</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${window.fmtMinutes(s.timeTotal)}</div><div class="kpi-l">Time logged</div></div>
      </div>
      <div class="page-scroll">
        ${renderWidgetGrid('report', 'report-grid', REPORT_WIDGETS, REPORT_LAYOUT, s)}
      </div>
    </div>`;
}

registerActions({
  'reports.export': () => exportReport(),
  'reports.openAi': () => { AI_REPORT=true;renderPage('reports'); },
  'reports.closeAi': () => { AI_REPORT=false;renderPage('reports'); },
});

registerWidgetCatalog('report', REPORT_WIDGETS, DEFAULT_REPORT_LAYOUT);

registerChangeActions({
  'reports.setTF': (ds, el) => setReportTF(el.value),
});
