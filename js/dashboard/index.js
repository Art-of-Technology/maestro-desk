// ─── Dashboard ────────────────────────────────────────────────────────────────
// Dashboard page: top KPIs, customisable widget grid, and the 13 widget tile
// renderers (recent activity, today, status, priority, SLA health, agent
// load, AI tags, workflows, KB, volume trend, top customers, personal,
// CSAT). The widget shell that hosts these tiles (drag/drop, hide/show,
// chart-type switcher, layout persistence) lives in `core/widget-shell.js`
// and is shared with the Reports page.
//
// External reaches (interim, via window): escAttr, escHtml — still in app.js.
// navTo and openTicket are now direct ES imports.
//
// No window-bridge namespace: the inline on*= handlers are delegated as
// dash.* actions (see the registerActions block at the bottom).
// openAgentFromDash stays exported — roles/index.js imports it directly
// (roles.openAgent). DASH_WIDGETS / DEFAULT_DASH_LAYOUT stay exported (app.js
// hydrates the layout from them) and are registered with the widget shell via
// registerWidgetCatalog('dash', …) at the bottom — no window exposure.
//
// TICKETS, AGENTS, WORKFLOWS, KB_ARTICLES, CUSTOMERS come from data.js via
// the global lexical env; SESSION, AGENT_SELECTED, KB_SELECTED, CUSTOMER_SELECTED,
// DASH_LAYOUT come from core/state.js the same way.

import { STATUS_COLORS, PRIORITY_COLORS } from '../core/colors.js';
import { renderWidgetGrid, registerWidgetCatalog } from '../core/widget-shell.js';
import { renderCategoricalChart } from '../core/chart.js';
import { computeReportStats } from '../reports/index.js';
import { navTo } from '../core/keybindings.js';
import { openTicket } from '../tickets/detail.js';
import { registerActions } from '../core/event-delegation.js';

export function openAgentFromDash(name) { AGENT_SELECTED = name; navTo('agents'); }
function openKBFromDash(id)      { KB_SELECTED = id;      navTo('kb'); }

function dashRecentTickets() {
  const tickets = [...TICKETS].slice(0, 6);
  const rows = tickets.map(t => `
    <div data-action="dash.openTicket" data-id="${window.escAttr(t.id)}" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
      <span class="tag tag-${t.status}" style="font-size:9px">${t.status}</span>
      <span class="tag tag-${t.priority}" style="font-size:9px">${t.priority}</span>
      <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);flex-shrink:0">${t.id}</span>
      <span style="flex:1;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500">${t.subject}</span>
      <span class="sla-${t.sla}" style="font-size:10px;text-transform:uppercase;font-weight:500;flex-shrink:0">${t.sla}</span>
      <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);flex-shrink:0">${t.updated}</span>
    </div>`).join('');
  return `
    <div class="card span-8">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Recent activity</div>
        <span class="link" data-action="dash.nav" data-page="tickets" style="font-size:11px">View all →</span>
      </div>
      ${rows || '<div style="color:var(--ink3);font-size:12px">No tickets yet</div>'}
    </div>`;
}

function dashStatus(s) {
  const items = Object.entries(s.byStatus).sort((a,b) => b[1] - a[1]);
  const chart = DASH_LAYOUT.charts['status'] || 'bar';
  return `
    <div class="card span-4">
      <div class="card-title">Status</div>
      ${renderCategoricalChart(items, k => STATUS_COLORS[k] || 'var(--ink3)', chart)}
    </div>`;
}

function dashSLA(s) {
  const chart = DASH_LAYOUT.charts['sla'] || 'tiles';
  const tilesBody = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px">
      <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt);padding:10px"><div class="r-tile-n" style="color:var(--green);font-size:20px">${s.slaOk}</div><div class="r-tile-l" style="color:var(--green);font-size:10px">On track</div></div>
      <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt);padding:10px"><div class="r-tile-n" style="color:var(--amber);font-size:20px">${s.slaWarn}</div><div class="r-tile-l" style="color:var(--amber);font-size:10px">Warning</div></div>
      <div class="r-tile" style="border-color:rgba(248,113,113,0.3);background:var(--red-lt);padding:10px"><div class="r-tile-n" style="color:var(--red);font-size:20px">${s.slaBreach}</div><div class="r-tile-l" style="color:var(--red);font-size:10px">Breach</div></div>
    </div>`;
  const barBody = renderCategoricalChart(
    [['on track', s.slaOk], ['warning', s.slaWarn], ['breach', s.slaBreach]],
    k => k === 'on track' ? 'var(--green)' : k === 'warning' ? 'var(--amber)' : 'var(--red)',
    'bar'
  );
  return `
    <div class="card span-4">
      <div class="card-title">SLA health</div>
      ${chart === 'bar' ? barBody : tilesBody}
      <div style="margin-top:12px;font-size:11px;color:var(--ink3)"><strong style="color:var(--ink2)">${s.slaCompliance}%</strong> compliance window</div>
    </div>`;
}

function dashAgentLoad() {
  const agents = AGENTS.filter(a => a.active).map(a => ({
    ...a,
    open: TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length
  })).sort((a, b) => b.open - a.open).slice(0, 5);
  if (!agents.length) return '<div class="card span-4"><div class="card-title">Agent load</div><div style="color:var(--ink3);font-size:12px">No active agents</div></div>';
  const max = Math.max(...agents.map(a => a.open), 1);
  const rows = agents.map(a => {
    const pct = (a.open / max) * 100;
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer" data-action="dash.openAgent" data-name="${window.escAttr(a.name)}">
        <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${a.initials}</div>
        <div style="font-size:12px;color:var(--ink2);width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.name}</div>
        <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--purple);height:100%;width:${pct}%"></div></div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:24px;text-align:right">${a.open}</div>
      </div>`;
  }).join('');
  return `
    <div class="card span-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Top open load</div>
        <span class="link" data-action="dash.nav" data-page="agents" style="font-size:11px">All →</span>
      </div>
      ${rows}
    </div>`;
}

function dashAITags() {
  const count = TICKETS.reduce((sum, t) => sum + (t.aiTags || []).filter(at => !at.accepted).length, 0);
  const tickets = TICKETS.filter(t => (t.aiTags || []).some(at => !at.accepted)).length;
  return `
    <div class="card span-4">
      <div class="card-title">AI tag suggestions</div>
      <div style="text-align:center;padding:14px 0">
        <div style="font-size:36px;font-weight:700;color:${count>0?'var(--purple)':'var(--ink3)'};font-family:'Inter',sans-serif;letter-spacing:-.02em;line-height:1">${count}</div>
        <div style="font-size:11px;color:var(--ink3);margin-top:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Pending review</div>
      </div>
      <div style="font-size:11px;color:var(--ink3);text-align:center;line-height:1.5">${count > 0 ? `Across ${tickets} ticket${tickets===1?'':'s'} — open a ticket to accept or dismiss.` : 'All current AI suggestions have been reviewed.'}</div>
    </div>`;
}

function dashWorkflows() {
  const active = WORKFLOWS.filter(w => w.status === 'active').length;
  const runs = WORKFLOWS.reduce((s, w) => s + (w.runCount || 0), 0);
  const recentlyRun = WORKFLOWS.filter(w => w.lastRun).slice(0, 2);
  return `
    <div class="card span-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Automation</div>
        <span class="link" data-action="dash.nav" data-page="workflows" style="font-size:11px">All →</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div class="r-tile" style="padding:12px"><div class="r-tile-n" style="color:var(--green);font-size:22px">${active}</div><div class="r-tile-l" style="color:var(--ink3);font-size:10px">Active</div></div>
        <div class="r-tile" style="padding:12px"><div class="r-tile-n" style="color:var(--purple);font-size:22px">${runs}</div><div class="r-tile-l" style="color:var(--ink3);font-size:10px">Runs (30d)</div></div>
      </div>
      ${recentlyRun.length ? `<div style="font-size:11px;color:var(--ink3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Recent</div>
        ${recentlyRun.map(w => `<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink2);padding:3px 0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${w.name}</span><span style="font-family:'DM Mono',monospace;color:var(--ink3);flex-shrink:0;margin-left:8px">${w.lastRun}</span></div>`).join('')}` : ''}
    </div>`;
}

function dashKB() {
  const articles = [...KB_ARTICLES].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 4);
  const rows = articles.map(a => `
    <div data-action="dash.openKB" data-id="${window.escAttr(a.id)}" style="padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;margin-bottom:5px;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)'" onmouseout="this.style.borderColor='var(--rule)'">
      <div style="font-size:10px;color:var(--purple);text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin-bottom:2px">${a.category}</div>
      <div style="font-size:12px;color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.title}</div>
    </div>`).join('');
  return `
    <div class="card span-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div class="card-title" style="margin:0">Knowledge base</div>
        <span class="link" data-action="dash.nav" data-page="kb" style="font-size:11px">All →</span>
      </div>
      ${rows || '<div style="color:var(--ink3);font-size:12px">No articles</div>'}
    </div>`;
}

function dashToday() {
  const recent = t => /min ago|just now|h ago/.test(t.updated || '');
  const created  = TICKETS.filter(recent).length;
  const resolved = TICKETS.filter(t => t.status === 'resolved' && recent(t)).length;
  const replies = TICKETS.reduce((s, t) => s + (t.msgs || []).filter(m => m.r === 'agent' || m.r === 'note').length, 0);
  return `
    <div class="card span-4">
      <div class="card-title">Today</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px">
        <div class="r-tile" style="padding:10px;border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan);font-size:20px">${created}</div><div class="r-tile-l" style="color:var(--cyan);font-size:9px">Touched</div></div>
        <div class="r-tile" style="padding:10px;border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green);font-size:20px">${resolved}</div><div class="r-tile-l" style="color:var(--green);font-size:9px">Resolved</div></div>
        <div class="r-tile" style="padding:10px;border-color:rgba(139,92,246,0.3);background:var(--purple-lt)"><div class="r-tile-n" style="color:var(--purple);font-size:20px">${replies}</div><div class="r-tile-l" style="color:var(--purple);font-size:9px">Replies</div></div>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--ink3);line-height:1.5">Activity in the last 24 hours.</div>
    </div>`;
}

function dashPriority(s) {
  const items = ['urgent','high','normal','low'].filter(p => s.byPriority[p]).map(p => [p, s.byPriority[p]]);
  const chart = DASH_LAYOUT.charts['priority'] || 'bar';
  // The default "bar" rendering for priority uses per-row gauges (different
  // shape from the stacked horizontal bar). Keep it for parity with the
  // existing UI; donut + list reuse the shared chart helper.
  if (chart === 'bar') {
    const max = Math.max(...items.map(i => i[1]), 1);
    const rows = items.map(([k, v]) => {
      const pct = (v / max) * 100;
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <div style="font-size:12px;color:var(--ink2);width:60px;text-transform:capitalize">${window.escHtml(k)}</div>
        <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${PRIORITY_COLORS[k]};height:100%;width:${pct}%"></div></div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:24px;text-align:right">${v}</div>
      </div>`;
    }).join('');
    return `
      <div class="card span-4">
        <div class="card-title">Priority</div>
        ${rows || '<div style="color:var(--ink3);font-size:12px">No tickets</div>'}
      </div>`;
  }
  return `
    <div class="card span-4">
      <div class="card-title">Priority</div>
      ${renderCategoricalChart(items, k => PRIORITY_COLORS[k] || 'var(--ink3)', chart)}
    </div>`;
}

function dashVolumeTrend() {
  // Build a 7-day deterministic series anchored on the latest ticket date in the seed
  const dates = TICKETS.map(t => new Date(t.created)).filter(d => !isNaN(d)).sort((a, b) => b - a);
  const today = dates[0] || new Date();
  const dowSeed = [4, 7, 9, 8, 6, 3, 2]; // Sun..Sat baseline volume
  const points = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const real = TICKETS.filter(t => t.created === iso).length;
    points.push({
      label: d.toLocaleDateString('en-US', { weekday: 'short' }),
      count: real + dowSeed[d.getDay()],
    });
  }
  const max = Math.max(...points.map(p => p.count), 1);
  const total = points.reduce((a, p) => a + p.count, 0);
  const w = 480, h = 90, padX = 12, padY = 8;
  const stepX = (w - padX * 2) / (points.length - 1);
  const yOf = c => h - padY - (c / max) * (h - padY * 2);
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${padX + i * stepX},${yOf(p.count)}`).join(' ');
  const areaPath = `${linePath} L ${padX + (points.length - 1) * stepX},${h - padY} L ${padX},${h - padY} Z`;
  return `
    <div class="card span-8">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px">
        <div class="card-title" style="margin:0">Ticket volume · last 7 days</div>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${total} touches</span>
      </div>
      <svg width="100%" height="110" viewBox="0 0 ${w} ${h + 18}" preserveAspectRatio="none" style="display:block">
        <path d="${areaPath}" fill="var(--purple)" fill-opacity=".15"/>
        <path d="${linePath}" fill="none" stroke="var(--purple)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${points.map((p, i) => `<circle cx="${padX + i * stepX}" cy="${yOf(p.count)}" r="2.5" fill="var(--purple)"/>`).join('')}
        ${points.map((p, i) => `<text x="${padX + i * stepX}" y="${h + 14}" text-anchor="middle" font-family="'DM Mono', monospace" font-size="9" fill="var(--ink3)">${p.label}</text>`).join('')}
      </svg>
    </div>`;
}

function dashTopCustomers() {
  const counts = {};
  TICKETS.forEach(t => { counts[t.customerId] = (counts[t.customerId] || 0) + 1; });
  const top = Object.entries(counts)
    .map(([id, c]) => ({ cust: CUSTOMERS.find(x => x.id === id), count: c }))
    .filter(x => x.cust)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  if (!top.length) return '<div class="card span-4"><div class="card-title">Top customers</div><div style="color:var(--ink3);font-size:12px">No data</div></div>';
  const max = top[0].count;
  const rows = top.map(({ cust, count }) => {
    const pct = (count / max) * 100;
    return `<div data-action="dash.openCustomer" data-cust-id="${window.escAttr(cust.id)}" style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer">
      <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${cust.first[0]}${cust.last[0]}</div>
      <div style="font-size:12px;color:var(--ink2);width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cust.first} ${cust.last}</div>
      <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--cyan);height:100%;width:${pct}%"></div></div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:24px;text-align:right">${count}</div>
    </div>`;
  }).join('');
  return `
    <div class="card span-4">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Top customers</div>
        <span class="link" data-action="dash.nav" data-page="customers" style="font-size:11px">All →</span>
      </div>
      ${rows}
    </div>`;
}

function dashPersonal() {
  if (!SESSION) return '';
  const my = TICKETS.filter(t => t.agent === SESSION.name);
  const open = my.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const csatRated = my.filter(t => t.csat);
  const avgCSAT = csatRated.length ? csatRated.reduce((a, t) => a + t.csat, 0) / csatRated.length : 0;
  const ranks = AGENTS.filter(a => a.active).map(a => ({
    name: a.name,
    open: TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length,
  })).sort((a, b) => b.open - a.open);
  const myRank = ranks.findIndex(r => r.name === SESSION.name) + 1;
  return `
    <div class="card span-4" data-action="dash.nav" data-page="profile" style="cursor:pointer">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Your stats</div>
        <span class="link" style="font-size:11px">Profile →</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#fff;flex-shrink:0">${SESSION.initials}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${SESSION.name}</div>
          <div style="font-size:11px;color:var(--ink3)">${SESSION.role}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:14px;text-align:center">
        <div><div style="font-size:18px;font-weight:700;color:var(--cyan);font-family:'Inter',sans-serif;line-height:1">${open}</div><div style="font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-top:4px">Open</div></div>
        <div><div style="font-size:18px;font-weight:700;color:var(--amber);font-family:'Inter',sans-serif;line-height:1">${csatRated.length?avgCSAT.toFixed(1):'—'}</div><div style="font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-top:4px">CSAT</div></div>
        <div><div style="font-size:18px;font-weight:700;color:var(--purple);font-family:'Inter',sans-serif;line-height:1">${myRank?'#'+myRank:'—'}</div><div style="font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;font-weight:500;margin-top:4px">Rank</div></div>
      </div>
    </div>`;
}

function dashCSAT(s) {
  const score = s.avgCSAT;
  const color = score >= 4 ? 'var(--green)' : score >= 3 ? 'var(--amber)' : score > 0 ? 'var(--red)' : 'var(--ink3)';
  return `
    <div class="card span-4">
      <div class="card-title">Customer satisfaction</div>
      <div style="text-align:center;padding:14px 0">
        <div style="font-size:42px;font-weight:700;color:${color};font-family:'Inter',sans-serif;letter-spacing:-.02em;line-height:1">${score?score.toFixed(1):'—'}</div>
        <div style="font-size:11px;color:var(--ink3);margin-top:8px">${s.csatCount} of ${s.total} tickets rated</div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--ink3);text-align:center"><span class="link" data-action="dash.nav" data-page="reports">View report →</span></div>
    </div>`;
}

export const DASH_WIDGETS = [
  { id:'today',       title:'Today',                 span:'span-12', render:s => dashToday() },
  { id:'recent',      title:'Recent tickets',        span:'span-8',  render:s => dashRecentTickets() },
  { id:'status',      title:'Status',                span:'span-4',  render:s => dashStatus(s),       charts:['bar','donut','list'] },
  { id:'priority',    title:'Priority',              span:'span-4',  render:s => dashPriority(s),     charts:['bar','donut','list'] },
  { id:'sla',         title:'SLA health',            span:'span-4',  render:s => dashSLA(s),          charts:['tiles','bar'] },
  { id:'volume',      title:'Volume trend',          span:'span-12', render:s => dashVolumeTrend() },
  { id:'csat',        title:'Customer satisfaction', span:'span-4',  render:s => dashCSAT(s) },
  { id:'agent-load',  title:'Agent load',            span:'span-8',  render:s => dashAgentLoad() },
  { id:'personal',    title:'My queue',              span:'span-4',  render:s => dashPersonal() },
  { id:'ai-tags',     title:'AI tag suggestions',    span:'span-4',  render:s => dashAITags() },
  { id:'workflows',   title:'Workflows',             span:'span-4',  render:s => dashWorkflows() },
  { id:'kb',          title:'Knowledge base',        span:'span-4',  render:s => dashKB() },
  { id:'top-customers', title:'Top customers',       span:'span-8',  render:s => dashTopCustomers() },
];

export const DEFAULT_DASH_LAYOUT = { order: DASH_WIDGETS.map(w => w.id), hidden: [], charts: {} };

export function renderDashboard() {
  // DASH_LAYOUT (in core/state.js) is hydrated at startup by app.js. Both
  // this module and the widget-shell handlers in app.js share that binding.
  const stats = computeReportStats(TICKETS);
  const open = TICKETS.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const pending = TICKETS.filter(t => t.status === 'pending').length;
  const gdpr = TICKETS.filter(t => t.status === 'gdpr').length;
  const breach = TICKETS.filter(t => t.sla === 'breach').length;
  const warn = TICKETS.filter(t => t.sla === 'warn').length;
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  })();
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">${greeting}${SESSION?.name?', '+SESSION.name.split(' ')[0]:''}</div>
      </div>
      <div class="kpi-bar" style="grid-template-columns:repeat(6,1fr)">
        <div class="kpi"><div class="kpi-n c-blue">${open}</div><div class="kpi-l">Open</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${pending}</div><div class="kpi-l">Pending</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${gdpr}</div><div class="kpi-l">GDPR</div></div>
        <div class="kpi"><div class="kpi-n c-red">${breach}</div><div class="kpi-l">SLA breach</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${warn}</div><div class="kpi-l">SLA warn</div></div>
        <div class="kpi"><div class="kpi-n c-green">${stats.resolved}</div><div class="kpi-l">Resolved</div></div>
      </div>
      <div class="page-scroll">
        ${renderWidgetGrid('dash', 'dash-grid-12', DASH_WIDGETS, DASH_LAYOUT, stats)}
      </div>
    </div>`;
}

registerWidgetCatalog('dash', DASH_WIDGETS, DEFAULT_DASH_LAYOUT);

registerActions({
  'dash.nav':          (ds) => navTo(ds.page),
  'dash.openTicket':   (ds) => openTicket(ds.id),
  'dash.openAgent':    (ds) => openAgentFromDash(ds.name),
  'dash.openKB':       (ds) => openKBFromDash(ds.id),
  'dash.openCustomer': (ds) => { CUSTOMER_SELECTED = ds.custId; navTo('customers'); },
});
