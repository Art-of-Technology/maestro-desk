// ─── SLA Policies config page ────────────────────────────────────────────────
// The SLA evaluator (computeTicketSLA, findMatchingSLAPolicy,
// fmtSLAMinutes, business-hours math) lives in tickets/sla.js — this module
// owns only the Config → SLA Policies page: the CRUD UI that creates,
// edits, toggles, and deletes entries in the SLA_POLICIES array.
//
// External reaches (interim, via window): isAdmin, escAttr,
// showModal, closeModal, renderPage — all still in app.js.
//
// SLA_POLICIES, TICKETS come from data.js via the global lexical env;
// SLA_FILTER comes from core/state.js the same way.

import { findMatchingSLAPolicy, fmtSLAMinutes } from './sla.js';

export function renderSLA() {
  const admin = window.isAdmin();
  let list = [...SLA_POLICIES];
  if (SLA_FILTER === 'active')   list = list.filter(p => p.status === 'active');
  if (SLA_FILTER === 'inactive') list = list.filter(p => p.status === 'inactive');
  const total    = SLA_POLICIES.length;
  const activeN  = SLA_POLICIES.filter(p => p.status === 'active').length;
  const avgFirst = activeN ? Math.round(SLA_POLICIES.filter(p => p.status==='active').reduce((s,p)=>s+p.firstResponseMin,0) / activeN) : 0;
  const avgRes   = activeN ? Math.round(SLA_POLICIES.filter(p => p.status==='active').reduce((s,p)=>s+p.resolutionMin,0)   / activeN) : 0;

  // Compute, per-policy, how many open tickets currently match it (resolved tickets excluded)
  const policyTicketCounts = {};
  TICKETS.forEach(t => {
    if (t.status === 'resolved') return;
    const m = findMatchingSLAPolicy(t);
    if (m) policyTicketCounts[m.id] = (policyTicketCounts[m.id] || 0) + 1;
  });

  const rows = list.map(p => {
    const matched = policyTicketCounts[p.id] || 0;
    return `
    <tr>
      <td class="bold">${p.id}</td>
      <td style="font-weight:500;color:var(--ink)">${p.name}</td>
      <td><span class="tag tag-${p.priority}">${p.priority}</span></td>
      <td>${p.category === 'all' ? '<span style="color:var(--ink3)">Any</span>' : p.category}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${fmtSLAMinutes(p.firstResponseMin)}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${fmtSLAMinutes(p.resolutionMin)}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px;color:${matched ? 'var(--ink2)' : 'var(--ink4)'}">${matched}</td>
      <td style="text-align:center">
        <label class="toggle">
          <input type="checkbox" ${p.status==='active'?'checked':''} ${admin?'':'disabled'} onchange="slaToggle('${window.escAttr(p.id)}',this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </td>
      ${admin ? `<td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" onclick="slaEdit('${window.escAttr(p.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="slaDelete('${window.escAttr(p.id)}')">Delete</button>
      </td>` : ''}
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">SLA Policies</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" onclick="slaNew()">+ New Policy</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Policies</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${fmtSLAMinutes(avgFirst)}</div><div class="kpi-l">Avg first-response</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${fmtSLAMinutes(avgRes)}</div><div class="kpi-l">Avg resolution</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <select class="filter-select" onchange="SLA_FILTER=this.value;renderPage('sla')">
          <option value="all"      ${SLA_FILTER==='all'?'selected':''}>All policies</option>
          <option value="active"   ${SLA_FILTER==='active'?'selected':''}>Active</option>
          <option value="inactive" ${SLA_FILTER==='inactive'?'selected':''}>Inactive</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div class="page-scroll">
        <table class="tbl">
          <thead><tr>
            <th>ID</th><th>Name</th><th>Priority</th><th>Category</th><th>First response</th><th>Resolution</th><th>Open tickets</th>
            <th style="text-align:center">Active</th>
            ${admin?'<th style="text-align:right">Actions</th>':''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No policies match</div><div class="empty-line"></div></div>` : ''}
        <div style="margin-top:14px;font-size:11px;color:var(--ink3);line-height:1.5;padding:0 4px">Policies are evaluated by priority + category match. The most-specific matching active policy wins (specific category beats <strong style="color:var(--ink2)">Any</strong>). Times are in minutes; values render as <strong style="color:var(--ink2)">Xm</strong>, <strong style="color:var(--ink2)">Yh Zm</strong>, or <strong style="color:var(--ink2)">Nd Yh</strong>.</div>
      </div>
    </div>`;
}

export function slaToggle(id, active) {
  if (!window.isAdmin()) return;
  const p = SLA_POLICIES.find(x => x.id === id);
  if (p) p.status = active ? 'active' : 'inactive';
}

function slaFormBody(p) {
  const cats = ['all', ...new Set(TICKETS.map(t => t.category))];
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="sla-name" value="${esc(p?.name)}" placeholder="e.g. Urgent · Technical"/></div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">Priority</label>
        <select class="form-input" id="sla-priority">
          ${['urgent','high','normal','low'].map(pr => `<option value="${pr}" ${p?.priority===pr?'selected':''}>${pr}</option>`).join('')}
        </select>
      </div>
      <div class="form-row"><label class="form-label">Category</label>
        <select class="form-input" id="sla-category">
          ${cats.map(c => `<option value="${c}" ${(p?.category||'all')===c?'selected':''}>${c==='all'?'Any':c}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label class="form-label">First response (minutes)</label><input class="form-input" id="sla-first" type="number" min="1" value="${p?.firstResponseMin||60}"/></div>
      <div class="form-row"><label class="form-label">Resolution (minutes)</label><input class="form-input" id="sla-res" type="number" min="1" value="${p?.resolutionMin||1440}"/></div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="font-family:'Inter',sans-serif;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)">Active</span>
      <label class="toggle"><input type="checkbox" id="sla-active" ${(!p || p.status==='active')?'checked':''}><span class="toggle-slider"></span></label>
    </div>
    <div id="sla-form-error" style="display:none;margin-top:8px;font-size:11px;color:var(--red);font-family:'DM Mono',monospace;letter-spacing:.04em"></div>`;
}

function slaNextId() {
  const max = Math.max(0, ...SLA_POLICIES.map(x => parseInt((x.id||'').split('-')[1] || '0', 10)));
  return 'SLA-' + String(max + 1).padStart(3, '0');
}

function slaShowError(msg) {
  const el = document.getElementById('sla-form-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function slaReadAndValidate() {
  const name  = document.getElementById('sla-name').value.trim();
  const first = parseInt(document.getElementById('sla-first').value, 10);
  const res   = parseInt(document.getElementById('sla-res').value, 10);
  if (!name) { slaShowError('Name is required.'); return null; }
  if (!Number.isFinite(first) || first < 1) { slaShowError('First response must be a positive number of minutes.'); return null; }
  if (!Number.isFinite(res)   || res   < 1) { slaShowError('Resolution must be a positive number of minutes.'); return null; }
  if (res < first) { slaShowError('Resolution must be at least the first-response window.'); return null; }
  return {
    name,
    priority: document.getElementById('sla-priority').value,
    category: document.getElementById('sla-category').value,
    firstResponseMin: first,
    resolutionMin: res,
    status: document.getElementById('sla-active').checked ? 'active' : 'inactive',
  };
}

export function slaNew() {
  if (!window.isAdmin()) return;
  window.showModal('New SLA policy', slaFormBody(null), () => {
    const data = slaReadAndValidate(); if (!data) return;
    SLA_POLICIES.unshift({ id: slaNextId(), ...data });
    window.closeModal(); window.renderPage('sla');
  }, 'Create');
}

export function slaEdit(id) {
  if (!window.isAdmin()) return;
  const p = SLA_POLICIES.find(x => x.id === id); if (!p) return;
  window.showModal(`Edit ${p.id}`, slaFormBody(p), () => {
    const data = slaReadAndValidate(); if (!data) return;
    Object.assign(p, data);
    window.closeModal(); window.renderPage('sla');
  }, 'Save');
}

export function slaDelete(id) {
  if (!window.isAdmin()) return;
  const p = SLA_POLICIES.find(x => x.id === id); if (!p) return;
  window.showModal('Delete policy', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${p.name}</strong>?</div>`, () => {
    const i = SLA_POLICIES.findIndex(x => x.id === id);
    if (i >= 0) SLA_POLICIES.splice(i, 1);
    window.closeModal(); window.renderPage('sla');
  }, 'Delete');
}
