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
// External reaches (interim, via window): escHtml, fmtMinutes, renderPage
// — still in app.js.
//
// TICKETS comes from data.js via the global lexical env; REPORT_LAYOUT
// comes from core/state.js the same way.

import { renderWidgetGrid } from '../core/widget-shell.js';
import { renderCategoricalChart } from '../core/chart.js';
import { ticketTotalMinutes, ticketBillableMinutes } from '../tickets/time-tracking.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';

import { STATUS_COLORS, PRIORITY_COLORS, SENTIMENT_COLORS } from '../core/colors.js';

// Timeframe filter — only the Reports page reads or writes this, so it
// stays module-local rather than going to core/state.js.
let REPORT_TF = '30d';

function setReportTF(v) { REPORT_TF = v; window.renderPage('reports'); }

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
    if      (t.sla === 'ok')     slaOk++;
    else if (t.sla === 'warn')   slaWarn++;
    else if (t.sla === 'breach') slaBreach++;
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
  const resolutionRate = total ? Math.round(resolved/total*100) : 0;
  const avgCSAT = csatScores.length ? csatScores.reduce((a,b)=>a+b,0)/csatScores.length : 0;
  const slaCompliance = total ? Math.round((slaOk + slaWarn)/total*100) : 0;
  return { total, byStatus, byPriority, byCategory, byAgent, bySentiment, sentimentScored, csatScores, csatCount:csatScores.length, avgCSAT, slaOk, slaWarn, slaBreach, slaCompliance, resolved, resolutionRate, timeTotal, timeBillable, timeByAgent };
}

function rBarRow(label, count, max, color) {
  const pct = max ? (count/max)*100 : 0;
  return `<div class="r-bar-row"><div class="r-bar-lbl">${window.escHtml(label)}</div><div class="r-bar-track"><div class="r-bar-fill" style="background:${color||'var(--purple)'};width:${pct}%"></div></div><div class="r-bar-val">${count}</div></div>`;
}

function reportStatus(s) {
  const items = Object.entries(s.byStatus).sort((a,b) => b[1] - a[1]);
  const chart = REPORT_LAYOUT.charts['r-status'] || 'bar';
  return `<div class="card"><div class="card-title">Status distribution</div>${renderCategoricalChart(items, k => STATUS_COLORS[k] || 'var(--ink3)', chart)}</div>`;
}

function reportPriority(s) {
  const items = ['urgent','high','normal','low'].filter(p => s.byPriority[p]).map(p => [p, s.byPriority[p]]);
  const chart = REPORT_LAYOUT.charts['r-priority'] || 'bar';
  return `<div class="card"><div class="card-title">Priority breakdown</div>${renderCategoricalChart(items, k => PRIORITY_COLORS[k] || 'var(--ink3)', chart)}</div>`;
}

function reportCategory(s) {
  const items = Object.entries(s.byCategory).sort((a,b) => b[1] - a[1]);
  const chart = REPORT_LAYOUT.charts['r-category'] || 'bar';
  return `<div class="card"><div class="card-title">Category volume</div>${renderCategoricalChart(items, () => 'var(--cyan)', chart)}</div>`;
}

function reportAgents(s) {
  const items = Object.entries(s.byAgent).sort((a,b) => b[1] - a[1]);
  const max = Math.max(...items.map(i => i[1]), 1);
  const rows = items.map(([name, count]) => rBarRow(name, count, max, 'var(--purple)')).join('');
  return `<div class="card"><div class="card-title">Tickets per agent</div>${rows || '<div style="color:var(--ink3);font-size:12px">No tickets in range</div>'}</div>`;
}

function reportCSAT(s) {
  const buckets = [1,2,3,4,5].map(n => s.csatScores.filter(x => x === n).length);
  const max = Math.max(...buckets, 1);
  const rows = buckets.map((c, i) => {
    const stars = '★'.repeat(i+1) + '☆'.repeat(4-i);
    const pct = (c/max)*100;
    return `<div class="r-bar-row"><div style="font-size:11px;color:var(--amber);width:60px;flex-shrink:0;letter-spacing:1px">${stars}</div><div class="r-bar-track"><div class="r-bar-fill" style="background:var(--amber);width:${pct}%"></div></div><div class="r-bar-val">${c}</div></div>`;
  }).reverse().join('');
  return `
    <div class="card">
      <div class="card-title">CSAT</div>
      <div style="display:flex;align-items:flex-end;gap:14px;margin:6px 0 14px">
        <div style="font-size:30px;font-weight:700;line-height:1;color:var(--amber);font-family:'Inter',sans-serif;letter-spacing:-.02em">${s.avgCSAT?s.avgCSAT.toFixed(1):'—'}</div>
        <div style="font-size:11px;color:var(--ink3);padding-bottom:4px">${s.csatCount} of ${s.total} tickets rated</div>
      </div>
      ${rows}
    </div>`;
}

function reportTime(s) {
  const items = Object.entries(s.timeByAgent || {}).sort((a, b) => b[1].total - a[1].total);
  const max = Math.max(...items.map(i => i[1].total), 1);
  const rows = items.map(([name, vals]) => {
    const pct = (vals.total / max) * 100;
    const billPct = vals.total ? (vals.billable / vals.total) * 100 : 0;
    return `<div class="r-bar-row">
      <div style="font-size:11px;color:var(--ink2);width:140px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(name || 'Unassigned')}</div>
      <div class="r-bar-track" title="${window.escHtml(window.fmtMinutes(vals.billable))} billable of ${window.escHtml(window.fmtMinutes(vals.total))}"><div class="r-bar-fill" style="background:var(--purple);width:${pct}%;position:relative"><div style="background:var(--amber);height:100%;width:${billPct}%"></div></div></div>
      <div class="r-bar-val" style="font-family:'DM Mono',monospace">${window.fmtMinutes(vals.total)}</div>
    </div>`;
  }).join('');
  const billPct = s.timeTotal ? Math.round((s.timeBillable / s.timeTotal) * 100) : 0;
  return `
    <div class="card">
      <div class="card-title">Time logged</div>
      <div style="display:flex;align-items:flex-end;gap:14px;margin:6px 0 14px">
        <div style="font-size:30px;font-weight:700;line-height:1;color:var(--purple);font-family:'Inter',sans-serif;letter-spacing:-.02em">${s.timeTotal ? window.fmtMinutes(s.timeTotal) : '—'}</div>
        <div style="font-size:11px;color:var(--ink3);padding-bottom:4px">${window.fmtMinutes(s.timeBillable)} billable · ${billPct}%</div>
      </div>
      ${rows || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:16px 0">No time logged in this range</div>'}
    </div>`;
}

function reportSentiment(s) {
  // Order angry → frustrated → neutral → positive so the visual flow
  // matches the urgency story (red on the left, green on the right).
  const ORDER = ['angry', 'frustrated', 'neutral', 'positive'];
  const items = ORDER.filter(k => s.bySentiment[k]).map(k => [k, s.bySentiment[k]]);
  const chart = REPORT_LAYOUT.charts['r-sentiment'] || 'bar';
  const unscored = s.total - (s.sentimentScored || 0);
  const footer = s.total === 0
    ? ''
    : `<div style="margin-top:10px;font-size:11px;color:var(--ink3)">${s.sentimentScored || 0} of ${s.total} tickets have a scored latest customer message${unscored > 0 ? ` · ${unscored} unscored` : ''}</div>`;
  const body = items.length
    ? renderCategoricalChart(items, k => SENTIMENT_COLORS[k] || 'var(--ink3)', chart)
    : '<div style="color:var(--ink3);font-size:12px;padding:14px 0;text-align:center">No scored sentiments in this range</div>';
  return `<div class="card"><div class="card-title">Customer sentiment</div>${body}${footer}</div>`;
}

function reportSLA(s) {
  return `
    <div class="card">
      <div class="card-title">SLA</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px">
        <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green)">${s.slaOk}</div><div class="r-tile-l" style="color:var(--green)">On track</div></div>
        <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${s.slaWarn}</div><div class="r-tile-l" style="color:var(--amber)">Warning</div></div>
        <div class="r-tile" style="border-color:rgba(248,113,113,0.3);background:var(--red-lt)"><div class="r-tile-n" style="color:var(--red)">${s.slaBreach}</div><div class="r-tile-l" style="color:var(--red)">Breached</div></div>
      </div>
      <div style="margin-top:14px;font-size:12px;color:var(--ink2);line-height:1.5"><strong style="color:var(--ink)">${s.slaCompliance}%</strong> of tickets are within SLA window</div>
    </div>`;
}

export const REPORT_WIDGETS = [
  { id:'r-status',    title:'Status breakdown',  render:s => reportStatus(s),    charts:['bar','donut'] },
  { id:'r-sla',       title:'SLA',               render:s => reportSLA(s),       charts:['tiles','bar'] },
  { id:'r-sentiment', title:'Customer sentiment',render:s => reportSentiment(s), charts:['bar','donut'] },
  { id:'r-priority',  title:'Priority',          render:s => reportPriority(s),  charts:['bar','donut'] },
  { id:'r-category',  title:'Category',          render:s => reportCategory(s),  charts:['bar','donut'] },
  { id:'r-agents',    title:'Tickets per agent', render:s => reportAgents(s) },
  { id:'r-csat',      title:'CSAT',              render:s => reportCSAT(s) },
  { id:'r-time',      title:'Time logged',       render:s => reportTime(s) },
];

export const DEFAULT_REPORT_LAYOUT = { order: REPORT_WIDGETS.map(w => w.id), hidden: [], charts: {} };

function exportReport() {
  const tickets = getReportTickets();
  const headers = ['ID','Subject','Status','Priority','Category','Agent','Created','Updated','SLA','CSAT','Sentiment','Time logged','Time billable'];
  const rows = tickets.map(t => [t.id, t.subject, t.status, t.priority, t.category, t.agent, t.created, t.updated, t.sla, t.csat ?? '', t.sentiment ?? '', window.fmtMinutes(ticketTotalMinutes(t)), window.fmtMinutes(ticketBillableMinutes(t))]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `tickets-${REPORT_TF}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export function renderReports() {
  const tf = REPORT_TF;
  const tickets = getReportTickets();
  const s = computeReportStats(tickets);
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Reports</div>
        <select class="filter-select" data-change-action="reports.setTF">
          <option value="7d"  ${tf==='7d'?'selected':''}>Last 7 days</option>
          <option value="30d" ${tf==='30d'?'selected':''}>Last 30 days</option>
          <option value="90d" ${tf==='90d'?'selected':''}>Last 90 days</option>
          <option value="all" ${tf==='all'?'selected':''}>All time</option>
        </select>
        <button class="btn btn-sm" data-action="reports.export">Export CSV</button>
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
});

registerChangeActions({
  'reports.setTF': (ds, el) => setReportTF(el.value),
});
