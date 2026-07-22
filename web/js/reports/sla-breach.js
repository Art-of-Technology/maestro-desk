// ─── SLA Breach report ───────────────────────────────────────────────────────
// Third Insights tab (Reports | Activity | SLA Breaches). Unlike the Reports
// page — which aggregates the in-memory TICKETS snapshot — this page is backed
// by GET /api/v1/reports/sla-breaches, because breach math needs two things
// the snapshot can't provide: every ticket in the date range (TICKETS is
// paginated) and each ticket's first agent reply time (messages only load
// when a detail view opens).
//
// The endpoint returns raw timestamps; evaluation happens here via
// evaluateSLATimestamps (business-hours aware, real clock — NOT the demo
// slaNowForDemo anchor) against the bootstrapped SLA_POLICIES, matched by
// findMatchingSLAPolicy on raw priority/category keys. Tickets with no
// matching active policy are excluded from every stat. Note BUSINESS_HOURS
// itself is still a client-side default (not workspace-synced) — a known
// engine-wide limitation, not specific to this page.
//
// Live-only: demo personas never hold a JWT, so the page renders an
// informational empty state without fetching (which is also what the CI
// route smoke exercises — sessionStorage is stubbed empty there).
//
// Async pattern copied from god/index.js: renderSLABreach() returns
// synchronously and kicks off load(); reRender() is guarded by
// document.body.dataset.currentPage.

import { nav, renderPage } from '../core/router.js';
import { pageTabs, INSIGHT_TABS } from '../core/page-tabs.js';
import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { findMatchingSLAPolicy, evaluateSLATimestamps, fmtSLAMinutes } from '../tickets/sla.js';
import { openTicket } from '../tickets/detail.js';
import { rBarRow } from './index.js';
import { downloadCSV } from '../core/csv.js';
import { showToast } from '../core/toast.js';
import { TICKETS } from '../core/data.js';

// ─── State ────────────────────────────────────────────────────────────────

let SB_DAYS = 30;
// wsId pins the cache to the workspace it was fetched for: the in-session
// workspace switcher swaps workspaces without a reload, and serving A's
// rows inside B would put cross-workspace data on screen. evaluated/stats
// are stashed by the render so Export CSV writes exactly what's displayed
// instead of re-evaluating at a later "now".
const SB = { loading: false, error: null, rows: null, loadedDays: null, wsId: null, evaluated: null, stats: null, truncated: false };

// ─── Data ─────────────────────────────────────────────────────────────────

async function load() {
  SB.loading = true;
  SB.error = null;
  const days = SB_DAYS;
  const wsId = getWorkspaceId();
  try {
    const res = await apiGet(`/api/v1/reports/sla-breaches?days=${days}`);
    // A stale response (user flipped the range or switched workspace while
    // this was in flight) is discarded; the re-render below re-kicks load.
    if (days === SB_DAYS && wsId === getWorkspaceId()) {
      SB.rows = res.tickets || [];
      SB.truncated = !!res.truncated;
      SB.loadedDays = days;
      SB.wsId = wsId;
    }
  } catch (e) {
    SB.error = e.message || 'Failed to load report';
  }
  SB.loading = false;
  reRender();
}

function reRender() {
  const main = document.getElementById('main-area');
  if (!main || document.body.dataset.currentPage !== 'sla-breach') return;
  main.innerHTML = renderSLABreach();
}

// Evaluate every fetched row against its matching policy with a single "now",
// quantized to the minute so businessMinutesBetween's (start,end)-keyed cache
// can actually hit across re-renders instead of growing one dead entry per
// row per render. Rows without an active matching policy are dropped — there
// is no window to breach. Returns [{ row, policy, ev, snoozed }].
function evaluateRows() {
  const nowMs = Math.floor(Date.now() / 60000) * 60000;
  const out = [];
  for (const row of SB.rows) {
    const policy = findMatchingSLAPolicy({ priority: row.priority_key, category: row.category_key });
    if (!policy) continue;
    const ev = evaluateSLATimestamps({
      createdMs:       new Date(row.created_at).getTime(),
      firstCustomerMs: row.first_customer_at ? new Date(row.first_customer_at).getTime() : null,
      firstReplyMs:    row.first_agent_reply_at ? new Date(row.first_agent_reply_at).getTime() : null,
      resolvedMs:      row.resolved_at ? new Date(row.resolved_at).getTime() : null,
      nowMs,
      policy,
    });
    const snoozed = !!(row.snoozed_until && new Date(row.snoozed_until).getTime() > nowMs);
    out.push({ row, policy, ev, snoozed });
  }
  return out;
}

function computeStats(evaluated) {
  const breached = evaluated.filter(x => x.ev.status === 'breach');
  // "At risk" is an act-now signal: unresolved, not snoozed, not yet
  // breached, and warning on a target whose clock is STILL RUNNING — a
  // historical first-reply that landed in the warn zone can't get worse,
  // so it doesn't count. Breached snoozed tickets still count as breaches —
  // snoozing pauses attention, not history.
  const atRisk = evaluated.filter(x =>
    !x.row.resolved_at && !x.snoozed && x.ev.status !== 'breach' &&
    (x.ev.resolutionStatus === 'warn' ||
     (x.ev.firstResponseStatus === 'warn' && !x.row.first_agent_reply_at))).length;
  const overruns = breached.map(x => Math.max(x.ev.firstResponseOverrunMin ?? 0, x.ev.resolutionOverrunMin ?? 0));
  const avgOverrun = overruns.length ? Math.round(overruns.reduce((a, b) => a + b, 0) / overruns.length) : 0;
  const met = evaluated.length - breached.length;
  const attainment = evaluated.length ? Math.round((met / evaluated.length) * 1000) / 10 : null;
  const frBreaches  = breached.filter(x => x.ev.firstResponseStatus === 'breach').length;
  const resBreaches = breached.filter(x => x.ev.resolutionStatus === 'breach').length;
  return { breached, atRisk, avgOverrun, met, attainment, frBreaches, resBreaches };
}

// ─── Widgets ──────────────────────────────────────────────────────────────

// Daily buckets for 7d/30d, weekly for 90d. The server window is a rolling
// now()−N days while buckets are midnight-anchored, so the daily loops run
// one extra bucket (i = SB_DAYS..0): the oldest bucket catches breaches from
// the partial first day that are in the data but before "midnight N−1 days
// ago" — otherwise the chart total visibly undercounts the KPI. Breaches
// are bucketed by ticket creation date — a v1 simplification (the true
// breach instant would need inverting businessMinutesBetween).
function sbByDayChart(breached) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const pad2 = n => String(n).padStart(2, '0');
  const mmDD = d => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const buckets = [];
  if (SB_DAYS === 90) {
    for (let i = 12; i >= 0; i--) {
      const end = new Date(now); end.setDate(end.getDate() - i * 7 + 1);
      const start = new Date(end); start.setDate(start.getDate() - 7);
      buckets.push({ label: mmDD(start), start, end });
    }
  } else {
    for (let i = SB_DAYS; i >= 0; i--) {
      const start = new Date(now); start.setDate(start.getDate() - i);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      const label = (SB_DAYS === 7 || i % 5 === 0) ? mmDD(start) : '';
      buckets.push({ label, start, end });
    }
  }
  for (const b of buckets) b.count = 0;
  for (const x of breached) {
    const c = new Date(x.row.created_at);
    for (const b of buckets) {
      if (c >= b.start && c < b.end) { b.count++; break; }
    }
  }
  const max = Math.max(1, ...buckets.map(b => b.count));
  const bars = buckets.map(b => `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0">
      <div style="flex:1;width:100%;display:flex;flex-direction:column;justify-content:flex-end" title="${b.label || mmDD(b.start)}: ${b.count}">
        <div style="height:${(b.count / max) * 100}%;background:var(--red-lt);border-top:2px solid ${b.count ? 'var(--red)' : 'transparent'};border-radius:2px 2px 0 0"></div>
      </div>
      <div style="font-size:9px;color:var(--ink3);font-family:'DM Mono',monospace;white-space:nowrap;min-height:11px">${b.label}</div>
    </div>`).join('');
  return `
    <div class="card">
      <div class="card-title">Breaches by day</div>
      <div style="display:flex;align-items:stretch;gap:3px;height:120px;padding:6px 0 2px">${bars}</div>
    </div>`;
}

function sbByTargetChart(s) {
  const max = Math.max(s.frBreaches, s.resBreaches, 1);
  return `
    <div class="card">
      <div class="card-title">By policy target</div>
      ${rBarRow('First reply', s.frBreaches, max, 'var(--red)')}
      ${rBarRow('Resolution', s.resBreaches, max, 'var(--purple)')}
      <div style="margin-top:12px;font-size:11px;color:var(--ink3)">A ticket can breach both targets.</div>
    </div>`;
}

function sbAttainmentRing(s, total) {
  if (s.attainment == null) {
    return `<div class="card"><div class="card-title">Attainment</div>
      <div style="color:var(--ink3);font-size:12px;padding:20px 0;text-align:center">No tickets matched an active SLA policy</div></div>`;
  }
  const deg = Math.round((s.met / total) * 360);
  return `
    <div class="card">
      <div class="card-title">Attainment</div>
      <div class="sb-ring-wrap">
        <div class="sb-ring" style="background:conic-gradient(var(--green) 0 ${deg}deg,var(--red) ${deg}deg 360deg)">
          <div class="sb-ring-inner">
            <span class="sb-ring-n">${s.attainment}%</span>
            <span class="sb-ring-l">met</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--ink2)">
          <span><span class="sb-dot" style="background:var(--green)"></span>${s.met} within SLA</span>
          <span><span class="sb-dot" style="background:var(--red)"></span>${s.breached.length} breached</span>
        </div>
      </div>
    </div>`;
}

// ─── Table ────────────────────────────────────────────────────────────────

function breachTargetCell(x) {
  const parts = [];
  if (x.ev.firstResponseStatus === 'breach') parts.push(`First reply · ${fmtSLAMinutes(x.policy.firstResponseMin)}`);
  if (x.ev.resolutionStatus === 'breach')    parts.push(`Resolution · ${fmtSLAMinutes(x.policy.resolutionMin)}`);
  return parts.join('<br>');
}

// A breach at exactly the window has zero overrun — that's a real breach
// with a real (zero) overrun, so show '0m' rather than fmtSLAMinutes's
// no-value glyph '—'.
function fmtOverrun(min) { return min > 0 ? fmtSLAMinutes(min) : '0m'; }

function sbTable(s) {
  if (!s.breached.length) {
    return `
      <div class="card">
        <div class="empty-state" style="border:none">
          <div class="empty-line"></div>
          <div class="empty-txt">No SLA breaches in this range</div>
        </div>
      </div>`;
  }
  const rows = s.breached.map(x => {
    const overrun = Math.max(x.ev.firstResponseOverrunMin ?? 0, x.ev.resolutionOverrunMin ?? 0);
    return `
      <tr data-action="slaBreach.open" data-ticket-id="${window.escAttr(x.row.display_id)}" style="cursor:pointer">
        <td style="font-family:'DM Mono',monospace;font-size:12px;color:var(--ink3)">${window.escHtml(x.row.display_id)}</td>
        <td class="bold">${window.escHtml(x.row.subject)}</td>
        <td>${window.escHtml(x.row.assignee_name || 'Unassigned')}</td>
        <td style="font-size:12px">${breachTargetCell(x)}</td>
        <td><span class="sla-breach">${fmtOverrun(overrun)}</span></td>
        <td><span class="tag tag-${window.escAttr(x.row.status_key)}">${window.escHtml(x.row.status_key)}</span></td>
        <td><span class="tag tag-${window.escAttr(x.row.priority_key)}">${window.escHtml(x.row.priority_key)}</span></td>
      </tr>`;
  }).join('');
  return `
    <div class="card" style="padding:0;overflow:hidden">
      <div style="padding:12px 16px;border-bottom:1px solid var(--rule)">
        <span class="card-title" style="margin:0">Breached tickets · ${s.breached.length}</span>
      </div>
      <table class="tbl">
        <thead><tr><th>ID</th><th>Subject</th><th>Assignee</th><th>Target breached</th><th>Overrun</th><th>Status</th><th>Priority</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ─── CSV export ───────────────────────────────────────────────────────────

// Exports the stats the last render computed (SB.stats), so the file always
// matches the table on screen — re-evaluating at click time could disagree
// with the visible numbers when a ticket crosses a threshold in between.
function exportBreaches() {
  const s = SB.stats;
  if (!s) return;
  const headers = ['ID', 'Subject', 'Assignee', 'Status', 'Priority', 'Policy', 'Target breached', 'Overrun (min)', 'Created', 'Resolved', 'First agent reply'];
  const rows = s.breached.map(x => [
    x.row.display_id, x.row.subject, x.row.assignee_name || '', x.row.status_key, x.row.priority_key,
    x.policy.name,
    [x.ev.firstResponseStatus === 'breach' ? 'first_reply' : '', x.ev.resolutionStatus === 'breach' ? 'resolution' : ''].filter(Boolean).join('+'),
    Math.max(x.ev.firstResponseOverrunMin ?? 0, x.ev.resolutionOverrunMin ?? 0),
    x.row.created_at, x.row.resolved_at || '', x.row.first_agent_reply_at || '',
  ]);
  downloadCSV(headers, rows, `sla-breaches-${SB_DAYS}d-${new Date().toISOString().slice(0, 10)}.csv`);
}

// ─── Page ─────────────────────────────────────────────────────────────────

function messageCard(title, bodyHtml, { wide = false } = {}) {
  return `
    <div class="page-scroll">
      <div class="card" style="max-width:${wide ? 560 : 520}px;margin:40px auto;text-align:center">
        <div class="card-title" style="margin-bottom:10px">${title}</div>
        <div style="font-size:13px;color:var(--ink3);line-height:1.6">${bodyHtml}</div>
      </div>
    </div>`;
}

function shell(body, { exportable = false } = {}) {
  return `
    <div class="page">
      <div class="topbar">
        ${pageTabs(INSIGHT_TABS, 'sla-breach')}
        <select class="filter-select" data-change-action="slaBreach.setDays">
          <option value="7"  ${SB_DAYS === 7 ? 'selected' : ''}>Last 7 days</option>
          <option value="30" ${SB_DAYS === 30 ? 'selected' : ''}>Last 30 days</option>
          <option value="90" ${SB_DAYS === 90 ? 'selected' : ''}>Last 90 days</option>
        </select>
        <button class="btn btn-sm" data-action="slaBreach.export" ${exportable ? '' : 'disabled'}>Export CSV</button>
      </div>
      ${body}
    </div>`;
}

export function renderSLABreach() {
  if (!getJwt()) {
    return shell(messageCard('Live workspaces only',
      `The SLA breach report reads reply times straight from the server, so it's
       only available when you're signed in to a live workspace.`));
  }
  // Workspace switched in-session → everything cached belongs to the old
  // workspace; drop it before deciding whether to fetch.
  if (SB.wsId !== null && SB.wsId !== getWorkspaceId()) {
    SB.rows = null; SB.loadedDays = null; SB.wsId = null;
    SB.evaluated = null; SB.stats = null; SB.error = null; SB.truncated = false;
  }
  if (SB.error) {
    return shell(messageCard('Couldn’t load the report',
      `${window.escHtml(SB.error)}<br><br>
       <button class="btn btn-sm" data-action="slaBreach.retry">Retry</button>`, { wide: true }));
  }
  if (SB.rows == null || SB.loadedDays !== SB_DAYS) {
    if (!SB.loading) load();
    return shell(messageCard('Loading…', 'Crunching reply times for the selected range.'));
  }

  const evaluated = evaluateRows();
  const s = computeStats(evaluated);
  SB.evaluated = evaluated;
  SB.stats = s;

  if (!evaluated.length) {
    const hint = SB.rows.length
      ? `None of the ${SB.rows.length} tickets in this range match an active SLA policy.
         <span class="link" data-action="slaBreach.policies">Configure SLA policies</span>`
      : 'No tickets in this range.';
    return shell(messageCard('Nothing to evaluate', hint, { wide: true }));
  }

  return shell(`
    <div class="kpi-bar">
      <div class="kpi"><div class="kpi-n c-red">${s.breached.length}</div><div class="kpi-l">Breaches</div></div>
      <div class="kpi"><div class="kpi-n c-amber">${s.atRisk}</div><div class="kpi-l">At risk right now</div></div>
      <div class="kpi"><div class="kpi-n c-red">${s.breached.length ? fmtOverrun(s.avgOverrun) : '—'}</div><div class="kpi-l">Avg overrun</div></div>
      <div class="kpi"><div class="kpi-n c-green">${s.attainment}%</div><div class="kpi-l">SLA attainment</div></div>
    </div>
    <div class="page-scroll">
      ${SB.truncated ? `<div style="margin-bottom:14px;padding:8px 12px;border:1px solid rgba(154,107,10,.3);background:var(--amber-lt);border-radius:var(--r);font-size:12px;color:var(--amber)">Large range: only the newest 5,000 tickets are included — these numbers are partial. Narrow the date range for full coverage.</div>` : ''}
      <div class="report-grid" style="margin-bottom:16px">
        ${sbByDayChart(s.breached)}
        ${sbByTargetChart(s)}
        ${sbAttainmentRing(s, evaluated.length)}
      </div>
      ${sbTable(s)}
    </div>`, { exportable: s.breached.length > 0 });
}

// ─── Actions ──────────────────────────────────────────────────────────────

registerActions({
  'slaBreach.export':   () => exportBreaches(),
  'slaBreach.retry':    () => { SB.error = null; SB.rows = null; reRender(); },
  'slaBreach.open':     (ds) => {
    // openTicket resolves against the paginated in-memory TICKETS snapshot
    // and silently bounces to the Conversations list on a miss — and this
    // report exists precisely because old tickets aren't in that snapshot.
    // Only navigate when the ticket is actually loadable; otherwise say so
    // instead of kicking the agent out of the report.
    if (TICKETS.some(t => t.id === ds.ticketId)) openTicket(ds.ticketId);
    else showToast(`${ds.ticketId} is outside the loaded ticket list — find it via search to open it.`, 'info');
  },
  'slaBreach.policies': () => nav('sla'),
});

registerChangeActions({
  'slaBreach.setDays': (ds, el) => {
    SB_DAYS = Number(el.value);
    renderPage('sla-breach');
  },
});
