// ─── Agents ──────────────────────────────────────────────────────────────────
// Agents config page: roster list with filter bar + KPIs, and per-agent
// detail view (stats, charts, recent activity, assigned tickets). Admins can
// add new agents here; role changes / activate-deactivate / delete still go
// through the shared helpers (reassignAgent, setAgentActive, deleteAgentPrompt)
// that live in roles/index.js because the Roles page calls them too.
//
// Click/change/input handlers route through core/event-delegation.js
// (`data-action` / `data-change-action` / `data-input-action`). The two
// onmouseover/onmouseout hover handlers in the recent-activity rows stay
// inline — pure `this.style.X = Y`, no module dep.
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml,
// fmtMinutes — all still in app.js. Everything else is a direct ES import.
//
// AGENTS, TICKETS, CUSTOMERS, ROLES_MATRIX, SESSION come from data.js;
// AGENT_SELECTED, CUSTOMER_SELECTED come from state.js (global lex env).

import { renderPage } from '../core/router.js';
import { STATUS_COLORS, PRIORITY_COLORS } from '../core/colors.js';
import { registerActions, registerChangeActions, registerInputActions } from '../core/event-delegation.js';
import { navTo } from '../core/keybindings.js';
import { openTicket } from '../tickets/detail.js';
import { showAgentOOOModal, isAgentOOO } from '../tickets/assignment-rules.js';
import { reassignAgent, setAgentActive, deleteAgentPrompt } from '../roles/index.js';
import { showModal, closeModal } from '../core/modal.js';

let AGENT_FILTER_ROLE = 'all';
let AGENT_FILTER_STATUS = 'all';
let AGENT_QUERY = '';

function getAgentStats(name) {
  const tickets = TICKETS.filter(t => t.agent === name);
  const open = tickets.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const resolved = tickets.filter(t => t.status === 'resolved').length;
  const csat = tickets.filter(t => t.csat);
  const avgCSAT = csat.length ? csat.reduce((a, t) => a + t.csat, 0) / csat.length : 0;
  return { tickets, total: tickets.length, open, resolved, csatCount: csat.length, avgCSAT };
}

export function renderAgents() {
  if (AGENT_SELECTED) return renderAgentDetail(AGENT_SELECTED);
  const admin = window.isAdmin();
  const allRoles = Object.keys(ROLES_MATRIX);

  let list = [...AGENTS];
  if (AGENT_FILTER_ROLE !== 'all')   list = list.filter(a => a.role === AGENT_FILTER_ROLE);
  if (AGENT_FILTER_STATUS === 'active')   list = list.filter(a => a.active);
  if (AGENT_FILTER_STATUS === 'inactive') list = list.filter(a => !a.active);
  if (AGENT_QUERY.trim()) {
    const q = AGENT_QUERY.toLowerCase();
    list = list.filter(a => a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q));
  }

  const total = AGENTS.length;
  const activeN = AGENTS.filter(a => a.active).length;
  const totalLoad = AGENTS.filter(a => a.active).reduce((sum, a) =>
    sum + TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length, 0);
  const avgLoad = activeN ? (totalLoad / activeN).toFixed(1) : '0';

  let topAgent = null, topCSAT = 0;
  AGENTS.forEach(a => {
    const s = getAgentStats(a.name);
    if (s.csatCount > 0 && s.avgCSAT > topCSAT) { topCSAT = s.avgCSAT; topAgent = a; }
  });

  const cards = list.map(a => {
    const s = getAgentStats(a.name);
    const ooo = isAgentOOO(a.name);
    return `
      <div class="agent-card ${a.active?'':'inactive'}" data-action="agents.openDetail" data-name="${window.escAttr(a.name)}">
        <div class="agent-card-head">
          <div class="agent-av">${a.initials}</div>
          <div style="flex:1;min-width:0">
            <div class="agent-name">${a.name}</div>
            <div class="agent-role">${a.role}</div>
          </div>
          ${ooo ? `<span class="tag" style="font-size:9px;flex-shrink:0;background:var(--amber-lt);color:var(--amber);border:1px solid var(--amber)" title="${window.escAttr(a.oooNote || ('Until ' + (a.oooTo || 'further notice')))}">OOO</span>` : `<span class="tag ${a.active?'tag-resolved':'tag-gdpr'}" style="font-size:9px;flex-shrink:0">${a.active?'Active':'Off'}</span>`}
        </div>
        ${ooo ? `<div style="font-size:11px;color:var(--amber);font-style:italic;line-height:1.4">${window.escHtml(a.oooNote || `On leave until ${a.oooTo || '—'}`)}</div>` : ''}
        <div class="agent-stats">
          <div class="agent-stat"><div class="agent-stat-n c-blue">${s.open}</div><div class="agent-stat-l">Open</div></div>
          <div class="agent-stat"><div class="agent-stat-n">${s.total}</div><div class="agent-stat-l">Total</div></div>
          <div class="agent-stat"><div class="agent-stat-n c-amber">${s.csatCount?s.avgCSAT.toFixed(1):'—'}</div><div class="agent-stat-l">CSAT</div></div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Agents</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" data-action="agents.new">+ Add Agent</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total agents</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${avgLoad}</div><div class="kpi-l">Avg open load</div></div>
        <div class="kpi"><div class="kpi-n c-amber" style="font-size:18px;line-height:1.1">${topAgent?topAgent.name:'—'}</div><div class="kpi-l">Top CSAT ${topAgent?'· '+topCSAT.toFixed(1):''}</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" id="agent-search" placeholder="Search agents…" style="width:200px" value="${AGENT_QUERY}" data-input-action="agents.setQuery"/>
        <select class="filter-select" data-change-action="agents.setRoleFilter">
          <option value="all" ${AGENT_FILTER_ROLE==='all'?'selected':''}>All roles</option>
          ${allRoles.map(r => `<option value="${r}" ${AGENT_FILTER_ROLE===r?'selected':''}>${r}</option>`).join('')}
        </select>
        <select class="filter-select" data-change-action="agents.setStatusFilter">
          <option value="all"      ${AGENT_FILTER_STATUS==='all'?'selected':''}>All statuses</option>
          <option value="active"   ${AGENT_FILTER_STATUS==='active'?'selected':''}>Active</option>
          <option value="inactive" ${AGENT_FILTER_STATUS==='inactive'?'selected':''}>Inactive</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        ${list.length
          ? `<div class="agent-grid">${cards}</div>`
          : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No agents match</div><div class="empty-line"></div></div>`}
      </div>
    </div>`;
}

function getAgentDeepStats(name) {
  const tickets = TICKETS.filter(t => t.agent === name);
  const byStatus = {}, byPriority = {}, byCategory = {};
  tickets.forEach(t => {
    byStatus[t.status]     = (byStatus[t.status]     || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    byCategory[t.category] = (byCategory[t.category] || 0) + 1;
  });
  const csatBuckets = [1,2,3,4,5].map(n => tickets.filter(t => t.csat === n).length);

  const custCounts = {};
  tickets.forEach(t => { custCounts[t.customerId] = (custCounts[t.customerId] || 0) + 1; });
  const topCustomers = Object.entries(custCounts)
    .map(([id, c]) => ({ cust: CUSTOMERS.find(x => x.id === id), count: c }))
    .filter(x => x.cust)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const tagCounts = {};
  tickets.forEach(t => (t.tags || []).forEach(tag => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }));
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const responseTimes = [];
  tickets.forEach(t => {
    const msgs = t.msgs || [];
    const firstCust = msgs.find(m => m.r === 'customer');
    if (!firstCust) return;
    const firstAgent = msgs.find(m => (m.r === 'agent' || m.r === 'ai') && msgs.indexOf(m) > msgs.indexOf(firstCust));
    if (firstAgent && /^\d+:\d+/.test(firstCust.ts) && /^\d+:\d+/.test(firstAgent.ts)) {
      const [ch, cm] = firstCust.ts.split(':').map(Number);
      const [ah, am] = firstAgent.ts.split(':').map(Number);
      const diff = Math.max(0, (ah - ch) * 60 + (am - cm));
      responseTimes.push(diff);
    }
  });
  const avgResponseMin = responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : 0;

  const activity = [];
  TICKETS.forEach(t => (t.msgs || []).forEach(m => {
    if (m.from === name) activity.push({ ticketId: t.id, subject: t.subject, role: m.r, text: m.t, ts: m.ts });
  }));
  const recent = activity.slice(-8).reverse();

  const ranks = AGENTS.filter(a => a.active).map(a => ({
    name: a.name,
    open: TICKETS.filter(t => t.agent === a.name && (t.status === 'open' || t.status === 'escalated')).length,
  })).sort((a, b) => b.open - a.open);
  const rank = ranks.findIndex(r => r.name === name) + 1;
  const totalActive = ranks.length;

  const slaOk = tickets.filter(t => t.sla === 'ok').length;
  const slaWarn = tickets.filter(t => t.sla === 'warn').length;
  const slaBreach = tickets.filter(t => t.sla === 'breach').length;
  const slaCompliance = tickets.length ? Math.round((slaOk + slaWarn) / tickets.length * 100) : 0;

  return { byStatus, byPriority, byCategory, csatBuckets, topCustomers, topTags, avgResponseMin, recent, rank, totalActive, slaOk, slaWarn, slaBreach, slaCompliance };
}

function agentBarRow(label, count, max, color) {
  const pct = max ? (count / max) * 100 : 0;
  return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
    <div style="font-size:11px;color:var(--ink2);width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:capitalize">${label}</div>
    <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${color || 'var(--purple)'};height:100%;width:${pct}%"></div></div>
    <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);width:24px;text-align:right">${count}</div>
  </div>`;
}

function renderAgentDetail(name) {
  const a = AGENTS.find(x => x.name === name);
  if (!a) { AGENT_SELECTED = null; return renderAgents(); }
  const s = getAgentStats(name);
  const d = getAgentDeepStats(name);
  const admin = window.isAdmin();
  const allRoles = Object.keys(ROLES_MATRIX);

  const statusItems = Object.entries(d.byStatus).sort((a, b) => b[1] - a[1]);
  const statusMax = Math.max(...statusItems.map(i => i[1]), 1);
  const statusBars = statusItems.map(([k, v]) => agentBarRow(k, v, statusMax, STATUS_COLORS[k] || 'var(--purple)')).join('') || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:6px 0">—</div>';

  const priItems = ['urgent','high','normal','low'].filter(p => d.byPriority[p]).map(p => [p, d.byPriority[p]]);
  const priMax = Math.max(...priItems.map(i => i[1]), 1);
  const priBars = priItems.map(([k, v]) => agentBarRow(k, v, priMax, PRIORITY_COLORS[k])).join('') || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:6px 0">—</div>';

  const catItems = Object.entries(d.byCategory).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(...catItems.map(i => i[1]), 1);
  const catBars = catItems.map(([k, v]) => agentBarRow(k, v, catMax, 'var(--cyan)')).join('') || '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:6px 0">—</div>';

  const csatMax = Math.max(...d.csatBuckets, 1);
  const csatRows = d.csatBuckets.map((c, i) => {
    const stars = '★'.repeat(i + 1) + '☆'.repeat(4 - i);
    const pct = (c / csatMax) * 100;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="font-size:11px;color:var(--amber);width:60px;flex-shrink:0;letter-spacing:1px">${stars}</div>
      <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--amber);height:100%;width:${pct}%"></div></div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:24px;text-align:right">${c}</div>
    </div>`;
  }).reverse().join('');

  const topCustRows = d.topCustomers.length ? d.topCustomers.map(({ cust, count }) => {
    const pct = (count / d.topCustomers[0].count) * 100;
    return `<div data-action="agents.openCustomer" data-cust-id="${window.escAttr(cust.id)}" style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer">
      <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${cust.first[0]}${cust.last[0]}</div>
      <div style="font-size:12px;color:var(--ink2);width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cust.first} ${cust.last}</div>
      <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--cyan);height:100%;width:${pct}%"></div></div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:22px;text-align:right">${count}</div>
    </div>`;
  }).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:8px 0">No customers handled</div>';

  const tagsBlock = d.topTags.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${d.topTags.map(([tag, c]) => `<span class="tag tag-neutral" style="font-size:11px;display:inline-flex;align-items:center;gap:5px">${tag} <span style="color:var(--ink3);font-family:'DM Mono',monospace">${c}</span></span>`).join('')}</div>`
    : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:8px 0">No tags used yet</div>';

  const recentRows = d.recent.length ? d.recent.map(r => `
    <div data-action="agents.openTicket" data-ticket-id="${window.escAttr(r.ticketId)}" style="padding:8px 4px;border-bottom:1px solid var(--rule);cursor:pointer;font-size:12px;transition:background .1s" onmouseover="this.style.background='var(--off2)'" onmouseout="this.style.background='transparent'">
      <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:3px">
        <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${r.ticketId}</span>
        ${r.role === 'note' ? '<span class="note-mark">Note</span>' : '<span style="font-size:9px;color:var(--purple);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Reply</span>'}
        <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink4);margin-left:auto">${r.ts}</span>
      </div>
      <div style="color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.text}</div>
    </div>`).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No activity recorded</div>';

  const ticketRows = s.tickets.map(t => {
    const cust = CUSTOMERS.find(c => c.id === t.customerId);
    return `<tr data-action="agents.openTicket" data-ticket-id="${window.escAttr(t.id)}" style="cursor:pointer">
      <td class="bold">${t.id}</td>
      <td>${cust ? cust.first + ' ' + cust.last : '—'}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.subject}</td>
      <td><span class="tag tag-${t.status}">${t.status}</span></td>
      <td><span class="tag tag-${t.priority}">${t.priority}</span></td>
      <td><span class="sla-${t.sla}" style="font-size:11px;text-transform:uppercase;font-weight:500">${t.sla}</span></td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${t.updated}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="agents.closeDetail">Agents</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${a.name}</span>
        </div>
      </div>
      <div class="page-scroll">
        <div style="display:flex;gap:14px;align-items:center;padding:8px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:18px">
          <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:16px;flex-shrink:0">${a.initials}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:18px;font-weight:600;color:var(--ink)">${a.name}</div>
            <div style="font-size:12px;color:var(--ink3);margin-top:2px">${a.role}${a.active && d.totalActive ? ` · Rank #${d.rank} of ${d.totalActive} by open load` : ''}</div>
          </div>
          ${isAgentOOO(a.name)
            ? `<span class="tag" style="background:var(--amber-lt);color:var(--amber);border:1px solid var(--amber)" title="${window.escAttr(a.oooNote || '')}">OOO${a.oooTo ? ' until ' + window.escHtml(a.oooTo) : ''}</span>`
            : `<span class="tag ${a.active?'tag-resolved':'tag-gdpr'}">${a.active?'Active':'Deactivated'}</span>`}
          ${admin || (SESSION && SESSION.name === a.name) ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            ${admin ? `<select class="filter-select" data-change-action="agents.reassign" data-name="${window.escAttr(a.name)}" style="font-size:12px">
              ${allRoles.map(r => `<option value="${r}" ${a.role===r?'selected':''}>${r}</option>`).join('')}
            </select>` : ''}
            <button class="btn btn-sm" data-action="agents.editOOO" data-name="${window.escAttr(a.name)}">${isAgentOOO(a.name) ? 'Edit OOO' : 'Set OOO'}</button>
            ${admin ? (a.active
              ? `<button class="btn btn-sm" data-action="agents.setActive" data-name="${window.escAttr(a.name)}" data-active="false">Deactivate</button>`
              : `<button class="btn btn-sm" data-action="agents.setActive" data-name="${window.escAttr(a.name)}" data-active="true">Activate</button>`) : ''}
            ${admin ? `<button class="btn btn-sm btn-danger" data-action="agents.delete" data-name="${window.escAttr(a.name)}">Delete</button>` : ''}
          </div>` : ''}
        </div>
        ${isAgentOOO(a.name) ? `<div style="margin:0 0 16px;padding:10px 14px;background:var(--amber-lt);border:1px solid var(--amber);border-radius:var(--r);font-size:12px;color:var(--amber);display:flex;gap:10px;align-items:center">
          <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:11px">Out of office</span>
          ${a.oooNote ? `<span style="color:var(--ink2);font-style:italic">${window.escHtml(a.oooNote)}</span>` : ''}
          <span style="margin-left:auto;font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(a.oooFrom)}${a.oooTo ? ' → ' + window.escHtml(a.oooTo) : ''}</span>
        </div>` : ''}

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${s.open}</div><div class="r-tile-l" style="color:var(--cyan)">Open</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${s.total}</div><div class="r-tile-l" style="color:var(--ink3)">Total assigned</div></div>
          <div class="r-tile" style="border-color:rgba(52,211,153,0.3);background:var(--green-lt)"><div class="r-tile-n" style="color:var(--green)">${s.resolved}</div><div class="r-tile-l" style="color:var(--green)">Resolved</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${s.csatCount?s.avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">CSAT (${s.csatCount})</div></div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Performance</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:6px">
            <div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:var(--ink);line-height:1">${a.active && d.totalActive ? '#'+d.rank : '—'}</div><div style="font-size:10px;color:var(--ink3);margin-top:4px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Rank by load</div></div>
            <div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:var(--ink);line-height:1">${window.fmtMinutes(d.avgResponseMin)}</div><div style="font-size:10px;color:var(--ink3);margin-top:4px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Avg first response</div></div>
            <div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:var(--ink);line-height:1">${s.total ? Math.round(s.resolved/s.total*100) + '%' : '—'}</div><div style="font-size:10px;color:var(--ink3);margin-top:4px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">Resolution rate</div></div>
            <div><div style="font-family:'DM Mono',monospace;font-size:18px;font-weight:600;color:${d.slaCompliance>=80?'var(--green)':d.slaCompliance>=60?'var(--amber)':'var(--red)'};line-height:1">${s.total ? d.slaCompliance + '%' : '—'}</div><div style="font-size:10px;color:var(--ink3);margin-top:4px;text-transform:uppercase;letter-spacing:.06em;font-weight:500">SLA compliance</div></div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px">
          <div class="card"><div class="card-title">By status</div>${statusBars}</div>
          <div class="card"><div class="card-title">By priority</div>${priBars}</div>
          <div class="card"><div class="card-title">By category</div>${catBars}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card">
            <div class="card-title">CSAT distribution</div>
            ${s.csatCount ? csatRows : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:20px 0">No CSAT ratings yet</div>'}
          </div>
          <div class="card">
            <div class="card-title">Top customers handled</div>
            ${topCustRows}
          </div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Most-used tags</div>
          ${tagsBlock}
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-title">Recent activity</div>
          ${recentRows}
        </div>

        <div class="card">
          <div class="card-title">Assigned tickets</div>
          ${s.tickets.length ? `
            <table class="tbl">
              <thead><tr><th>ID</th><th>Customer</th><th>Subject</th><th>Status</th><th>Priority</th><th>SLA</th><th>Updated</th></tr></thead>
              <tbody>${ticketRows}</tbody>
            </table>
          ` : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tickets assigned</div><div class="empty-line"></div></div>`}
        </div>
      </div>
    </div>`;
}

function openAgentDetail(name) { AGENT_SELECTED = name; renderPage('agents'); }
function closeAgentDetail()    { AGENT_SELECTED = null; renderPage('agents'); }
function agentSetRole(v)       { AGENT_FILTER_ROLE = v; renderPage('agents'); }
function agentSetStatus(v)     { AGENT_FILTER_STATUS = v; renderPage('agents'); }
function agentSetQuery(v) {
  AGENT_QUERY = v;
  renderPage('agents');
  const input = document.getElementById('agent-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function agentNew() {
  if (!window.isAdmin()) return;
  const allRoles = Object.keys(ROLES_MATRIX);
  showModal('Add agent', `
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Full name</label><input class="form-input" id="ag-name" placeholder="Jane Doe"/></div>
      <div class="form-row"><label class="form-label">Initials</label><input class="form-input" id="ag-init" maxlength="3" placeholder="JD"/></div>
    </div>
    <div class="form-row"><label class="form-label">Role</label>
      <select class="form-input" id="ag-role">${allRoles.map(r => `<option value="${r}" ${r==='Senior Agent'?'selected':''}>${r}</option>`).join('')}</select>
    </div>
  `, () => {
    const name = document.getElementById('ag-name').value.trim();
    const role = document.getElementById('ag-role').value;
    let init = document.getElementById('ag-init').value.trim().toUpperCase();
    if (!name || AGENTS.find(a => a.name === name)) return;
    if (!init) init = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    AGENTS.push({ name, initials: init, role, active: true });
    closeModal(); renderPage('agents');
  }, 'Add');
}

registerActions({
  'agents.openDetail':    (ds) => openAgentDetail(ds.name),
  'agents.closeDetail':   () => closeAgentDetail(),
  'agents.new':           () => agentNew(),
  'agents.openCustomer':  (ds) => { CUSTOMER_SELECTED = ds.custId; navTo('customers'); },
  'agents.openTicket':    (ds) => openTicket(ds.ticketId),
  'agents.editOOO':       (ds) => showAgentOOOModal(ds.name),
  'agents.setActive':     (ds) => setAgentActive(ds.name, ds.active === 'true'),
  'agents.delete':        (ds) => deleteAgentPrompt(ds.name),
});

registerChangeActions({
  'agents.setRoleFilter':   (ds, el) => agentSetRole(el.value),
  'agents.setStatusFilter': (ds, el) => agentSetStatus(el.value),
  'agents.reassign':        (ds, el) => reassignAgent(ds.name, el.value),
});

registerInputActions({
  'agents.setQuery': (ds, el) => agentSetQuery(el.value),
});
