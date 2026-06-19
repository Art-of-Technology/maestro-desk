// ─── Customers ────────────────────────────────────────────────────────────────
// Customers list page (column manager, bulk actions, group-by, view chips,
// CSV export) and the per-customer detail view (profile, custom fields, risk
// indicators, activity timeline, notes, related tickets). Customer merge /
// un-merge bookkeeping lives at the bottom: tickets reassign with a stamp so
// the reversal can restore them, and primary-record backfill is undoable.
//
// Click/change/input/mousedown handlers route through
// core/event-delegation.js. Drag-to-reorder on the column headers uses
// module-internal document-level listeners at the bottom of this file
// (scoped via `closest('th[draggable="true"]')`; coexists with
// widget-shell's drag dispatcher because the selectors disambiguate).
// Pure-style onmouseover/onmouseout hover effects stay inline (PR #105
// rule).
//
// External reaches (interim, via window): escAttr, escHtml, isAdmin —
// all still in app.js. openTicket, showManageFieldsModal,
// showCSVModal and showNewCustomerModal are direct ES imports. The
// customers↔customers/modals.js cycle (modals.js imports refreshCustTable
// from this module; this module imports the modal openers back) is tolerated
// — the openers are only used inside registerActions closures, never at
// module top level.

import { CUSTOMERS, CUSTOM_FIELDS, TICKETS } from '../core/data.js';
import { CUSTOMER_SELECTED, CUSTOMER_SELECTED_IDS, CUST_COLUMNS, CUST_DRAG_COL, SESSION, setCustColumns, setCustDragCol, setCustomerSelected } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { logTicketEvent } from '../core/activity-log.js';
import { showModal, closeModal } from '../core/modal.js';
import { isFieldVisible } from '../layouts/index.js';
import { registerActions, registerChangeActions, registerInputActions, registerMousedownActions } from '../core/event-delegation.js';
import { openTicket } from '../tickets/detail.js';
import { showManageFieldsModal } from '../custom-fields/index.js';
import { showCSVModal, showNewCustomerModal } from './modals.js';
import { apiPut, getBrandId } from '../core/api-client.js';
import { startPresence } from '../core/presence.js';
import { playerLookupActive, renderPlayerLookupView } from './player-lookup.js';

// ─── Customer table column state ─────────────────────────────────────────────

function getCustColumns() {
  const customCols = CUSTOM_FIELDS.map(f=>({id:'cf_'+f.id,label:f.label,fixed:false,isCustom:true,cfId:f.id}));
  customCols.forEach(cc=>{
    if(!CUST_COLUMNS.find(c=>c.id===cc.id)) CUST_COLUMNS.push({...cc,visible:false});
  });
  setCustColumns(CUST_COLUMNS.filter(c=>!c.isCustom||CUSTOM_FIELDS.find(f=>'cf_'+f.id===c.id)));
  return CUST_COLUMNS;
}

function custCellValue(c, colId) {
  if(colId==='id') return `<td class="bold">${c.id}</td>`;
  if(colId==='name') return `<td style="font-weight:500;color:var(--ink)">${c.first} ${c.last}</td>`;
  if(colId==='username') return `<td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${c.username}</td>`;
  if(colId==='brand') return `<td>${c.brand}</td>`;
  if(colId==='vip') return `<td><span class="vip-badge vip-${c.vip.toLowerCase()}">${c.vip}</span></td>`;
  if(colId==='jurisdiction') return `<td style="font-family:'DM Mono',monospace;font-size:11px">${c.jurisdiction}</td>`;
  if(colId==='consent') return `<td><span class="tag ${c.consent?'tag-resolved':'tag-gdpr'}">${c.consent?'Yes':'No'}</span></td>`;
  if(colId==='kyc') return `<td><span class="tag ${c.kyc==='Verified'?'tag-resolved':'tag-pending'}">${c.kyc}</span></td>`;
  if(colId.startsWith('cf_')) { const cfId=colId.slice(3); return `<td style="font-size:12px;color:var(--ink2)">${c.custom?.[cfId]||'—'}</td>`; }
  return '<td>—</td>';
}

function buildCustRows(list) {
  const cols = getCustColumns().filter(c=>c.visible);
  return list.map(c => {
    const checked = CUSTOMER_SELECTED_IDS.has(c.id);
    return `<tr data-action="cust.openProfile" data-cust-id="${window.escAttr(c.id)}" style="cursor:pointer${checked?';background:var(--purple-lt)':''}">
      <td style="width:32px;padding-right:0" data-action="">
        <input type="checkbox" ${checked?'checked':''} data-change-action="cust.toggleSelected" data-cust-id="${window.escAttr(c.id)}" style="cursor:pointer;accent-color:var(--purple)" />
      </td>
      ${cols.map(col=>custCellValue(c,col.id)).join('')}
    </tr>`;
  }).join('');
}

function buildCustHeaders() {
  const cols = getCustColumns().filter(c=>c.visible);
  const ids = applyCustFilters().map(c => c.id);
  const allSelected = ids.length > 0 && ids.every(id => CUSTOMER_SELECTED_IDS.has(id));
  const checkboxHeader = `<th style="width:32px;padding-right:0" data-action="">
    <input type="checkbox" ${allSelected?'checked':''} data-change-action="cust.toggleAll" style="cursor:pointer;accent-color:var(--purple)" title="Select all in view"/>
  </th>`;
  return checkboxHeader + cols.map((col,i)=>`<th draggable="true" data-col-idx="${i}" style="cursor:grab;user-select:none;white-space:nowrap" title="Drag to reorder">${col.label} <span style="opacity:.3;font-size:10px">⠿</span></th>`).join('');
}

function dropCustCol(targetIdx) {
  const vis = getCustColumns().filter(c=>c.visible);
  const all = getCustColumns();
  if(CUST_DRAG_COL===null||CUST_DRAG_COL===targetIdx) return;
  const src=vis[CUST_DRAG_COL], tgt=vis[targetIdx];
  if(!src||!tgt||src.fixed||tgt.fixed) return;
  const si=all.indexOf(src), ti=all.indexOf(tgt);
  all.splice(si,1); all.splice(ti,0,src);
  setCustDragCol(null);
  refreshCustTable(CUSTOMERS);
}

export function refreshCustTable(list) {
  const thead = document.getElementById('cust-thead');
  const tbody = document.getElementById('cust-tbody');
  if (thead) thead.innerHTML = buildCustHeaders();
  if (tbody) {
    const groups = groupCustomersBy(list, CUST_GROUP_BY);
    const groupHeader = key => `<tr style="background:var(--off2)"><td colspan="20" style="padding:8px 14px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)">${key}</td></tr>`;
    tbody.innerHTML = groups.map(g =>
      (g.key !== null ? groupHeader(`${g.key} · ${g.items.length}`) : '') + buildCustRows(g.items)
    ).join('');
  }
}

function showColumnPanel() {
  const cols=getCustColumns();
  showModal('Manage columns', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px">Toggle columns on/off. Drag column headers in the table to reorder.</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${cols.map((col,i)=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);background:var(--off2)">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;font-weight:500;color:var(--ink)">${col.label}</span>
            ${col.isCustom?`<span style="font-size:10px;color:var(--purple);background:var(--purple-lt);padding:1px 6px;border-radius:3px">Custom</span>`:''}
            ${col.fixed?`<span style="font-size:10px;color:var(--ink3)">(always shown)</span>`:''}
          </div>
          <label class="toggle">
            <input type="checkbox" ${col.visible?'checked':''} ${col.fixed?'disabled':''} data-change-action="cust.toggleCol" data-col-idx="${i}">
            <span class="toggle-slider"></span>
          </label>
        </div>`).join('')}
    </div>
  `, null, null);
}

let CUST_QUERY = '';
let CUST_VIP_FILTER = 'all';
let CUST_BRAND_FILTER = 'all';
let CUST_VIEW_FILTER = 'all';
let CUST_GROUP_BY = 'none';
// CUSTOMER_SELECTED_IDS lives in core/state.js so the renderPage page-guard
// in app.js can clear it on navigation away from the customers tab.

function applyCustFilters() {
  let list = [...CUSTOMERS];
  // Hide merged-into duplicates by default; the "Merged" view chip surfaces them on demand.
  if (CUST_VIEW_FILTER === 'merged') list = list.filter(c => c.mergedInto);
  else                               list = list.filter(c => !c.mergedInto);
  if (CUST_VIEW_FILTER === 'premium')         list = list.filter(c => c.vip === 'Platinum' || c.vip === 'Gold');
  else if (CUST_VIEW_FILTER === 'kyc-pending') list = list.filter(c => c.kyc !== 'Verified');
  else if (CUST_VIEW_FILTER === 'no-consent')  list = list.filter(c => !c.consent);
  else if (CUST_VIEW_FILTER === 'at-risk')     list = list.filter(c => TICKETS.some(t => t.customerId === c.id && (t.sla === 'breach' || t.status === 'escalated')));
  if (CUST_QUERY.trim()) {
    const q = CUST_QUERY.toLowerCase();
    list = list.filter(c => (c.first+' '+c.last+' '+c.username+' '+c.id+' '+c.email+' '+c.brand).toLowerCase().includes(q));
  }
  if (CUST_VIP_FILTER !== 'all')   list = list.filter(c => c.vip === CUST_VIP_FILTER);
  if (CUST_BRAND_FILTER !== 'all') list = list.filter(c => c.brand === CUST_BRAND_FILTER);
  return list;
}

function groupCustomersBy(list, by) {
  if (by === 'none') return [{ key: null, items: list }];
  const groups = new Map();
  list.forEach(c => {
    let key = (c[by] || '—') + '';
    if (by === 'consent') key = c.consent ? 'Consent given' : 'No consent';
    groups.has(key) || groups.set(key, []);
    groups.get(key).push(c);
  });
  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}

function setCustView(v) { CUST_VIEW_FILTER = v; renderPage('customers'); }
function setCustGroupBy(v) { CUST_GROUP_BY = v; renderPage('customers'); }

function toggleCustSelected(id) {
  if (CUSTOMER_SELECTED_IDS.has(id)) CUSTOMER_SELECTED_IDS.delete(id);
  else CUSTOMER_SELECTED_IDS.add(id);
  renderPage('customers');
}

function toggleAllCustomers() {
  const ids = applyCustFilters().map(c => c.id);
  const all = ids.length > 0 && ids.every(id => CUSTOMER_SELECTED_IDS.has(id));
  if (all) ids.forEach(id => CUSTOMER_SELECTED_IDS.delete(id));
  else ids.forEach(id => CUSTOMER_SELECTED_IDS.add(id));
  renderPage('customers');
}

function clearCustSelection() { CUSTOMER_SELECTED_IDS.clear(); renderPage('customers'); }

function bulkSetCustVIP(v) {
  if (!v || CUSTOMER_SELECTED_IDS.size === 0) return;
  CUSTOMERS.forEach(c => { if (CUSTOMER_SELECTED_IDS.has(c.id)) c.vip = v; });
  CUSTOMER_SELECTED_IDS.clear();
  renderPage('customers');
}
function bulkSetCustConsent(v) {
  if (!v || CUSTOMER_SELECTED_IDS.size === 0) return;
  CUSTOMERS.forEach(c => { if (CUSTOMER_SELECTED_IDS.has(c.id)) c.consent = v === 'yes'; });
  CUSTOMER_SELECTED_IDS.clear();
  renderPage('customers');
}
function bulkDeleteCustomers() {
  const n = CUSTOMER_SELECTED_IDS.size;
  if (n === 0) return;
  showModal(`Delete ${n} customer${n===1?'':'s'}`, `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${n}</strong> customer${n===1?'':'s'}? Tickets they own will be orphaned.</div>`, () => {
    for (let i = CUSTOMERS.length - 1; i >= 0; i--) {
      if (CUSTOMER_SELECTED_IDS.has(CUSTOMERS[i].id)) CUSTOMERS.splice(i, 1);
    }
    CUSTOMER_SELECTED_IDS.clear();
    closeModal();
    renderPage('customers');
  }, 'Delete');
}

function exportCustomerList() {
  const list = applyCustFilters();
  const headers = ['ID','First','Last','Username','Email','Mobile','Brand','VIP','Jurisdiction','Consent','KYC','Since'];
  const rows = list.map(c => [c.id, c.first, c.last, c.username, c.email, c.mobile, c.brand, c.vip, c.jurisdiction, c.consent ? 'Yes' : 'No', c.kyc, c.since]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `customers-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function filterCustomers(q) { CUST_QUERY = q; refreshCustTable(applyCustFilters()); refreshCustCounter(); }
function refreshCustCounter() {
  const el = document.getElementById('cust-counter'); if (!el) return;
  el.textContent = `${applyCustFilters().length} of ${CUSTOMERS.length}`;
}
function custSetVIP(v)   { CUST_VIP_FILTER = v;   renderPage('customers'); }
function custSetBrand(v) { CUST_BRAND_FILTER = v; renderPage('customers'); }

export function renderCustomers() {
  // Live player lookup (search the whole brand roster from Maestro) takes over
  // the page when active — see ./player-lookup.js. Checked before the local
  // detail branch; the two selections are mutually exclusive in practice.
  if (playerLookupActive()) return renderPlayerLookupView();
  if (CUSTOMER_SELECTED) return renderCustomerDetail(CUSTOMER_SELECTED);
  getCustColumns();
  const filtered = applyCustFilters();
  const total = CUSTOMERS.length;
  const brands = [...new Set(CUSTOMERS.map(c => c.brand))];
  const vipCounts = { Platinum:0, Gold:0, Silver:0, Bronze:0 };
  CUSTOMERS.forEach(c => { if (vipCounts[c.vip] !== undefined) vipCounts[c.vip]++; });
  const premium = vipCounts.Platinum + vipCounts.Gold;
  const avgPerCust = total ? (TICKETS.length / total).toFixed(1) : '0';
  const consentRate = total ? Math.round(CUSTOMERS.filter(c => c.consent).length / total * 100) : 0;

  // View chip counts
  const kycPendingN = CUSTOMERS.filter(c => c.kyc !== 'Verified').length;
  const noConsentN  = CUSTOMERS.filter(c => !c.consent).length;
  const atRiskN     = CUSTOMERS.filter(c => TICKETS.some(t => t.customerId === c.id && (t.sla === 'breach' || t.status === 'escalated'))).length;
  const mergedN = CUSTOMERS.filter(c => c.mergedInto).length;
  const views = [
    { k: 'all',         l: 'All',                         active: CUST_VIEW_FILTER === 'all' },
    { k: 'premium',     l: `Premium · ${premium}`,        active: CUST_VIEW_FILTER === 'premium' },
    { k: 'kyc-pending', l: `KYC pending · ${kycPendingN}`, active: CUST_VIEW_FILTER === 'kyc-pending' },
    { k: 'no-consent',  l: `No consent · ${noConsentN}`,  active: CUST_VIEW_FILTER === 'no-consent' },
    { k: 'at-risk',     l: `At risk · ${atRiskN}`,        active: CUST_VIEW_FILTER === 'at-risk' },
    { k: 'merged',      l: `Merged · ${mergedN}`,         active: CUST_VIEW_FILTER === 'merged' },
  ];

  const groups = groupCustomersBy(filtered, CUST_GROUP_BY);
  const groupHeader = key => `<tr style="background:var(--off2)"><td colspan="20" style="padding:8px 14px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)">${key}</td></tr>`;
  const tableBody = groups.map(g =>
    (g.key !== null ? groupHeader(`${g.key} · ${g.items.length}`) : '') + buildCustRows(g.items)
  ).join('');

  const bulkBar = CUSTOMER_SELECTED_IDS.size > 0 ? `
    <div style="padding:8px 20px;border-bottom:1px solid var(--rule);background:var(--purple-lt);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--purple);font-weight:600">${CUSTOMER_SELECTED_IDS.size} selected</span>
      <select class="filter-select" data-change-action="cust.bulkSetVIP">
        <option value="">Set VIP tier…</option>
        <option value="Platinum">Platinum</option>
        <option value="Gold">Gold</option>
        <option value="Silver">Silver</option>
        <option value="Bronze">Bronze</option>
      </select>
      <select class="filter-select" data-change-action="cust.bulkSetConsent">
        <option value="">Set consent…</option>
        <option value="yes">Consent: Yes</option>
        <option value="no">Consent: No</option>
      </select>
      <button class="btn btn-sm btn-danger" data-action="cust.bulkDelete">Delete</button>
      <button class="btn btn-sm" data-action="cust.clearSelection" style="margin-left:auto">Clear selection</button>
    </div>` : '';

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Customers</div>
        ${getBrandId() ? `<button class="btn btn-sm" data-action="players.lookup" title="Search every player in this brand, live from Maestro">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.2"/><path d="M7.7 7.7L11 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          Look up player
        </button>` : ''}
        <button class="btn btn-sm" data-action="cust.showColumnPanel">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="3" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="5" y="1" width="3" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="1" width="2" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>
          Columns
        </button>
        <button class="btn btn-sm" data-action="cust.manageFields">Fields</button>
        <button class="btn btn-sm" data-action="cust.csvImport">CSV Import</button>
        <button class="btn btn-sm" data-action="cust.export">Export CSV</button>
        <button class="btn btn-sm btn-solid" data-action="cust.new">+ New Customer</button>
      </div>
      <div class="kpi-bar" style="grid-template-columns:repeat(5,1fr)">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Customers</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${premium}</div><div class="kpi-l">Premium VIP</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${brands.length}</div><div class="kpi-l">Brands</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${avgPerCust}</div><div class="kpi-l">Avg tickets</div></div>
        <div class="kpi"><div class="kpi-n c-green">${consentRate}%</div><div class="kpi-l">Consent</div></div>
      </div>
      ${bulkBar}
      <div class="filter-bar" style="flex-wrap:wrap">
        <span class="filter-label">Filter</span>
        <input class="filter-select" placeholder="Search name, username, ID, email, brand…" style="width:240px" value="${CUST_QUERY}" data-input-action="cust.filter"/>
        <select class="filter-select" data-change-action="cust.setVIP">
          <option value="all"      ${CUST_VIP_FILTER==='all'?'selected':''}>All VIP tiers</option>
          <option value="Platinum" ${CUST_VIP_FILTER==='Platinum'?'selected':''}>Platinum</option>
          <option value="Gold"     ${CUST_VIP_FILTER==='Gold'?'selected':''}>Gold</option>
          <option value="Silver"   ${CUST_VIP_FILTER==='Silver'?'selected':''}>Silver</option>
          <option value="Bronze"   ${CUST_VIP_FILTER==='Bronze'?'selected':''}>Bronze</option>
        </select>
        <select class="filter-select" data-change-action="cust.setBrand">
          <option value="all" ${CUST_BRAND_FILTER==='all'?'selected':''}>All brands</option>
          ${brands.map(b => `<option value="${window.escAttr(b)}" ${CUST_BRAND_FILTER===b?'selected':''}>${window.escHtml(b)}</option>`).join('')}
        </select>
        <select class="filter-select" data-change-action="cust.setGroupBy" title="Group rows">
          <option value="none"         ${CUST_GROUP_BY==='none'?'selected':''}>No grouping</option>
          <option value="vip"          ${CUST_GROUP_BY==='vip'?'selected':''}>Group by VIP</option>
          <option value="brand"        ${CUST_GROUP_BY==='brand'?'selected':''}>Group by brand</option>
          <option value="jurisdiction" ${CUST_GROUP_BY==='jurisdiction'?'selected':''}>Group by jurisdiction</option>
          <option value="kyc"          ${CUST_GROUP_BY==='kyc'?'selected':''}>Group by KYC</option>
          <option value="consent"      ${CUST_GROUP_BY==='consent'?'selected':''}>Group by consent</option>
        </select>
        <span id="cust-counter" style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${filtered.length} of ${total}</span>
      </div>
      <div class="filter-bar" style="border-top:none;padding-top:6px;padding-bottom:10px">
        <span class="filter-label">View</span>
        ${views.map(v => `<span class="filter-tag" style="cursor:pointer;${v.active?'border-color:var(--purple);color:var(--purple);background:var(--purple-lt)':''}" data-action="cust.setView" data-view="${window.escAttr(v.k)}">${v.l}</span>`).join('')}
      </div>
      <div style="flex:1;overflow:auto">
        <table class="tbl" style="min-width:500px">
          <thead><tr id="cust-thead">${buildCustHeaders()}</tr></thead>
          <tbody id="cust-tbody">${tableBody}</tbody>
        </table>
        ${filtered.length === 0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No customers match</div><div class="empty-line"></div></div>` : ''}
      </div>
    </div>`;
}

function getCustomerStats(custId) {
  const tickets = TICKETS.filter(t => t.customerId === custId);
  const open = tickets.filter(t => t.status === 'open' || t.status === 'escalated').length;
  const resolved = tickets.filter(t => t.status === 'resolved').length;
  const csat = tickets.filter(t => t.csat);
  const avgCSAT = csat.length ? csat.reduce((a, t) => a + t.csat, 0) / csat.length : 0;
  return { tickets, total: tickets.length, open, resolved, csatCount: csat.length, avgCSAT };
}

function getCustomerActivity(custId) {
  const items = [];
  TICKETS.filter(t => t.customerId === custId).forEach(t => {
    (t.msgs || []).forEach(m => items.push({
      ticketId: t.id,
      from: m.from,
      role: m.r,
      text: m.t,
      ts: m.ts,
    }));
  });
  return items.slice(-15).reverse();
}

function getCustomerCommonTags(custId) {
  const counts = {};
  TICKETS.filter(t => t.customerId === custId).forEach(t => {
    (t.tags || []).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1; });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function getCustomerRisk(c) {
  const tickets = TICKETS.filter(t => t.customerId === c.id);
  const flags = [];
  const breaches = tickets.filter(t => t.sla === 'breach').length;
  if (breaches > 0) flags.push({ level: 'high', text: `${breaches} SLA breach${breaches>1?'es':''}` });
  const escalated = tickets.filter(t => t.status === 'escalated').length;
  if (escalated > 0) flags.push({ level: 'high', text: `${escalated} escalated` });
  if (tickets.filter(t => t.status === 'gdpr').length > 0) flags.push({ level: 'high', text: 'Active GDPR request' });
  if (!c.consent) flags.push({ level: 'medium', text: 'No marketing consent' });
  if (c.kyc !== 'Verified') flags.push({ level: 'medium', text: `KYC ${c.kyc}` });
  return flags;
}

function addCustomerNote(custId) {
  showModal('Add internal note', `<div class="form-row"><label class="form-label">Note</label><textarea class="form-input" id="cn-text" style="min-height:120px;font-family:'Inter',sans-serif" placeholder="Context the team should know about this customer…"></textarea></div>`, () => {
    const text = document.getElementById('cn-text').value.trim();
    if (!text) return;
    const c = CUSTOMERS.find(x => x.id === custId);
    if (!c) return;
    if (!c.notes) c.notes = [];
    c.notes.unshift({
      author: SESSION?.name || 'Unknown',
      ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
      text,
    });
    closeModal(); renderPage('customers');
  }, 'Add note');
}

function deleteCustomerNote(custId, idx) {
  const c = CUSTOMERS.find(x => x.id === custId);
  if (!c || !c.notes) return;
  c.notes.splice(idx, 1);
  renderPage('customers');
}

function openCustomerProfile(id) { setCustomerSelected(id); renderPage('customers'); }
function closeCustomerProfile()  { setCustomerSelected(null); renderPage('customers'); }

// ─── Customer merge ─────────────────────────────────────────────────────────
// Combines a duplicate customer record into a primary. Tickets reassign their
// customerId, notes copy across, and missing profile fields are pulled from
// the source if the primary's value was empty. Each affected ticket is tagged
// with `preMergeCustomerId` so unmergeCustomer can reliably restore them.
function showMergeCustomerModal(custId) {
  const src = CUSTOMERS.find(x => x.id === custId);
  if (!src) return;
  if (src.mergedInto) { alert(`Already merged into ${src.mergedInto}.`); return; }
  // Candidates: not self and not themselves a merged duplicate. A previously-
  // unmerged customer that used to have custId merged in is still a valid
  // primary, so we don't filter that out.
  const candidates = CUSTOMERS.filter(x => x.id !== custId && !x.mergedInto);
  if (!candidates.length) {
    showModal('Merge customer into…', '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No primary candidates available.</div>', null, null);
    return;
  }
  const card = c => `
    <div data-mousedown-action="cust.mergeFromModal" data-source="${window.escAttr(custId)}" data-target="${window.escAttr(c.id)}" style="padding:10px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
      <div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0">${window.escHtml((c.first[0]||'') + (c.last[0]||''))}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--ink)">${window.escHtml(c.first + ' ' + c.last)}</div>
        <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(c.id)} · ${window.escHtml(c.email || '')}</div>
      </div>
      <span class="vip-badge vip-${(c.vip || '').toLowerCase()}">${window.escHtml(c.vip || '')}</span>
    </div>`;
  showModal('Merge customer into…', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">${window.escHtml(src.first + ' ' + src.last)} (${window.escHtml(src.id)}) will be marked as a duplicate of the primary you choose. All of this customer's tickets reassign to the primary, internal notes copy over, and any blank profile fields on the primary fill in from this record.</div>
    <div style="max-height:380px;overflow-y:auto">${candidates.map(card).join('')}</div>
  `, null, null);
}

function mergeCustomers(srcId, primaryId) {
  if (srcId === primaryId) return;
  const src = CUSTOMERS.find(x => x.id === srcId);
  const primary = CUSTOMERS.find(x => x.id === primaryId);
  if (!src || !primary || src.mergedInto) return;
  if (primary.mergedInto) {
    alert(`${primaryId} is already a duplicate of ${primary.mergedInto}. Pick the chain's primary instead.`);
    return;
  }
  // Reassign tickets, stamping each with the original customerId so un-merge
  // can put them back on the source if the merge is reversed.
  TICKETS.forEach(t => {
    if (t.customerId === srcId) {
      t.preMergeCustomerId = srcId;
      t.customerId = primaryId;
      logTicketEvent(t.id, 'system', `Customer merged: ${srcId} → ${primaryId}`);
    }
  });
  // Merge notes: append src.notes onto primary.notes with a separator marker
  // so an admin can see the boundary.
  if (src.notes && src.notes.length) {
    if (!primary.notes) primary.notes = [];
    primary.notes.push({ author:'System', ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }), text: `── Notes merged from ${srcId} ──`, mergedFromCustomerId: srcId });
    src.notes.forEach(n => primary.notes.push({ ...n, mergedFromCustomerId: srcId }));
  }
  // Backfill primary fields from src where primary is blank, recording which
  // fields we touched so unmergeCustomer can put the primary back the way it
  // was instead of leaving it carrying the source's data forever.
  primary._mergeBackfilled = primary._mergeBackfilled || {};
  primary._mergeBackfilled[srcId] = { fields: [], custom: [] };
  ['email','mobile','username','brand','vip','jurisdiction','kyc','since','bo'].forEach(f => {
    if (!primary[f] && src[f]) {
      primary[f] = src[f];
      primary._mergeBackfilled[srcId].fields.push(f);
    }
  });
  if (src.custom) {
    primary.custom = primary.custom || {};
    Object.keys(src.custom).forEach(k => {
      if (primary.custom[k] === undefined || primary.custom[k] === '') {
        primary.custom[k] = src.custom[k];
        primary._mergeBackfilled[srcId].custom.push(k);
      }
    });
  }
  src.mergedInto = primaryId;
  src.mergedAt = new Date().toISOString().slice(0, 10);
  primary.mergedFrom = primary.mergedFrom || [];
  if (!primary.mergedFrom.includes(srcId)) primary.mergedFrom.push(srcId);
  // Navigate to the primary so the agent sees the consolidated view.
  setCustomerSelected(primaryId);
  renderPage('customers');
}

function unmergeCustomer(srcId) {
  const src = CUSTOMERS.find(x => x.id === srcId);
  if (!src || !src.mergedInto) return;
  const primaryId = src.mergedInto;
  const primary = CUSTOMERS.find(x => x.id === primaryId);
  // Walk tickets and put them back on the source.
  TICKETS.forEach(t => {
    if (t.preMergeCustomerId === srcId && t.customerId === primaryId) {
      t.customerId = srcId;
      delete t.preMergeCustomerId;
      logTicketEvent(t.id, 'system', `Customer un-merged: restored to ${srcId}`);
    }
  });
  // Strip notes that came from src, including the separator marker.
  if (primary && primary.notes) {
    primary.notes = primary.notes.filter(n => n.mergedFromCustomerId !== srcId);
  }
  // Roll back fields the merge backfilled from this source, so the primary
  // returns to the state it was in pre-merge for those fields.
  if (primary && primary._mergeBackfilled?.[srcId]) {
    const back = primary._mergeBackfilled[srcId];
    (back.fields || []).forEach(f => { primary[f] = ''; });
    if (primary.custom && back.custom) (back.custom || []).forEach(k => { delete primary.custom[k]; });
    delete primary._mergeBackfilled[srcId];
  }
  if (primary && primary.mergedFrom) primary.mergedFrom = primary.mergedFrom.filter(x => x !== srcId);
  delete src.mergedInto;
  delete src.mergedAt;
  setCustomerSelected(srcId);
  renderPage('customers');
}

async function updateCustomField(custId, fieldId, value) {
  const c = CUSTOMERS.find(x => x.id === custId);
  if (!c) return;
  if (!c.custom) c.custom = {};
  if (c._uuid) {
    try {
      await apiPut(`/api/v1/custom-values/customers/${c._uuid}/${encodeURIComponent(fieldId)}`, { value: value || null });
    } catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
  }
  c.custom[fieldId] = value;
}

function showCustomerGDPR(custId) {
  showModal('GDPR actions', `
    <div class="gdpr-action"><div class="gdpr-action-title">Request erasure</div><div class="gdpr-action-desc">Permanently delete this customer's personal data under Article 17.</div><button class="btn btn-sm btn-danger" data-action="cust.closeGdpr">Request erasure</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">Redact in-thread data</div><div class="gdpr-action-desc">Mask PII in this customer's ticket messages.</div><button class="btn btn-sm" data-action="cust.closeGdpr">Redact</button></div>
    <div class="gdpr-action"><div class="gdpr-action-title">SAR export</div><div class="gdpr-action-desc">Export all data held about this customer.</div><button class="btn btn-sm" data-action="cust.closeGdpr">Export</button></div>
  `, null, null);
}

// Small inline indicator for the email row. Hard / spam bounces are
// the actionable cases (mail won't deliver) — soft bounces accumulate
// silently in the count without alarming the agent.
function renderBounceBadge(c) {
  const state = c.emailBounceState || 'none';
  if (state !== 'hard' && state !== 'spam') return '';
  const label = state === 'spam' ? 'SPAM' : 'BOUNCING';
  const title = `${state === 'spam' ? 'Marked as spam' : 'Email bouncing'} — ${c.emailBounceCount || 0} event${(c.emailBounceCount || 0) === 1 ? '' : 's'}`;
  return `<span title="${window.escAttr(title)}" style="margin-left:8px;display:inline-block;padding:1px 6px;font-size:10px;font-weight:600;color:var(--red);background:var(--red-lt);border:1px solid rgba(248,113,113,0.4);border-radius:3px;font-family:'DM Mono',monospace">${label}</span>`;
}

function renderCustomerDetail(custId) {
  const c = CUSTOMERS.find(x => x.id === custId);
  if (!c) { setCustomerSelected(null); return renderCustomers(); }
  // Real-time presence — no-ops for demo personas (no _uuid). Chip
  // slot is in the topbar below; the first heartbeat resolves after
  // main.innerHTML is set, so the slot is in the DOM by then.
  // No #presence-banner slot here — that's the "Emma is replying"
  // typing-indicator strip above the compose textarea, which only
  // makes sense for surfaces that have a composer (ticket detail).
  if (c._uuid && SESSION?.userId) startPresence('customer', c._uuid);
  const s = getCustomerStats(custId);
  const admin = window.isAdmin();
  const activity = getCustomerActivity(custId);
  const tagsList = getCustomerCommonTags(custId);
  const risks = getCustomerRisk(c);
  const notes = c.notes || [];

  const ticketRows = s.tickets.map(t => `
    <tr data-action="cust.openTicket" data-ticket-id="${window.escAttr(t.id)}" style="cursor:pointer">
      <td class="bold">${t.id}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--ink)">${t.subject}</td>
      <td><span class="tag tag-${t.status}">${t.status}</span></td>
      <td><span class="tag tag-${t.priority}">${t.priority}</span></td>
      <td>${t.agent}</td>
      <td><span class="sla-${t.sla}" style="font-size:11px;text-transform:uppercase;font-weight:500">${t.sla}</span></td>
      <td style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${t.updated}</td>
    </tr>`).join('');

  const customFields = CUSTOM_FIELDS.map(cf => {
    const val = c.custom?.[cf.id] ?? '';
    const inputType = cf.type === 'number' ? 'number' : cf.type === 'date' ? 'date' : 'text';
    return `
      <div class="form-row">
        <label class="form-label">${cf.label}</label>
        ${admin
          ? `<input class="form-input" type="${inputType}" value="${String(val).replace(/"/g,'&quot;')}" data-input-action="cust.updateField" data-cust-id="${window.escAttr(c.id)}" data-field-id="${window.escAttr(cf.id)}"/>`
          : `<div style="font-size:13px;color:var(--ink);padding:9px 12px;background:var(--off2);border:1px solid var(--rule);border-radius:var(--r);min-height:36px;display:flex;align-items:center">${val || '<span style="color:var(--ink3)">—</span>'}</div>`}
      </div>`;
  }).join('') || '<div style="color:var(--ink3);font-size:12px;padding:8px 0">No custom fields defined. Admins can add them via Manage Fields on the list view.</div>';

  const riskPanel = risks.length ? `
    <div class="card" style="margin-bottom:16px;border-color:rgba(248,113,113,0.3);background:rgba(248,113,113,0.04)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l6 11H1L7 1z" stroke="var(--red)" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 5v3M7 10v.5" stroke="var(--red)" stroke-width="1.4" stroke-linecap="round"/></svg>
        <div class="card-title" style="margin:0;color:var(--red)">Risk indicators</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${risks.map(r => `<span class="tag" style="font-size:10px;border-color:${r.level==='high'?'rgba(248,113,113,0.5)':'rgba(251,191,36,0.5)'};color:${r.level==='high'?'var(--red)':'var(--amber)'};background:${r.level==='high'?'var(--red-lt)':'var(--amber-lt)'}">${r.text}</span>`).join('')}
      </div>
    </div>` : '';

  const tagsBlock = tagsList.length ? `
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Common topics</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${tagsList.map(([tag, count]) => `<span class="tag tag-neutral" style="font-size:11px;display:inline-flex;align-items:center;gap:5px">${tag} <span style="color:var(--ink3);font-family:'DM Mono',monospace">${count}</span></span>`).join('')}
      </div>
    </div>` : '';

  const timelineBlock = activity.length ? `
    <div class="card">
      <div class="card-title">Activity timeline</div>
      <div class="cust-timeline">
        ${activity.map(a => `
          <div class="cust-timeline-item role-${a.role}" data-action="cust.openTicket" data-ticket-id="${window.escAttr(a.ticketId)}">
            <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:3px">
              <span style="font-size:11px;font-weight:600;color:var(--ink)">${a.from}</span>
              ${a.role === 'note' ? '<span class="note-mark">Note</span>' : a.role === 'ai' ? '<span class="ai-mark">AI</span>' : ''}
              <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${a.ticketId}</span>
              <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink4);margin-left:auto">${a.ts}</span>
            </div>
            <div style="font-size:12px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.text}</div>
          </div>
        `).join('')}
      </div>
    </div>` : `<div class="card"><div class="card-title">Activity timeline</div><div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No activity yet</div></div>`;

  const notesBlock = `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">Internal notes</div>
        <button class="btn btn-sm" data-action="cust.addNote" data-cust-id="${window.escAttr(c.id)}">+ Add note</button>
      </div>
      ${notes.length ? notes.map((n, i) => `
        <div class="cust-note">
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px">
            <span style="font-size:11px;font-weight:600;color:var(--ink)">${n.author}</span>
            <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${n.ts}</span>
            ${admin ? `<button class="btn btn-sm btn-danger" style="margin-left:auto;padding:2px 8px;font-size:10px;border:none;background:transparent;color:var(--ink3)" data-action="cust.deleteNote" data-cust-id="${window.escAttr(c.id)}" data-note-idx="${i}" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--ink3)'" title="Delete note">×</button>` : ''}
          </div>
          <div style="font-size:12.5px;color:var(--ink2);line-height:1.55;white-space:pre-wrap">${n.text}</div>
        </div>
      `).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No notes yet — share context with the team by adding one.</div>'}
    </div>`;

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="cust.closeProfile">Customers</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${c.first} ${c.last}</span>
          <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <div id="presence-chips" class="presence-chips" aria-label="Agents viewing this customer"></div>
          </span>
        </div>
      </div>
      <div class="page-scroll">
        <div style="display:flex;gap:14px;align-items:center;padding:8px 0 18px;border-bottom:1px solid var(--rule);margin-bottom:18px">
          <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;font-size:16px;flex-shrink:0">${(c.first||'').charAt(0)}${(c.last||'').charAt(0)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:18px;font-weight:600;color:var(--ink)">${c.first} ${c.last}</div>
            <div style="font-size:12px;color:var(--ink3);margin-top:4px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <span style="font-family:'DM Mono',monospace">${c.id}</span>
              <span class="vip-badge vip-${c.vip.toLowerCase()}">${c.vip}</span>
              <span>${c.brand}</span>
              <span style="font-family:'DM Mono',monospace">${c.jurisdiction}</span>
            </div>
          </div>
          ${c.mergedInto ? `<span class="tag" style="flex-shrink:0;background:var(--purple-lt);color:var(--purple);border:1px solid var(--purple)">Merged → ${window.escHtml(c.mergedInto)}</span>` : `<span class="tag ${c.kyc==='Verified'?'tag-resolved':'tag-pending'}" style="flex-shrink:0">${c.kyc}</span>`}
        </div>
        ${c.mergedInto ? `<div style="margin:0 0 16px;padding:10px 14px;background:var(--purple-lt);border:1px solid var(--purple);border-radius:var(--r);font-size:11px;color:var(--purple);display:flex;align-items:center;gap:10px">
          <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Merged duplicate</span>
          <span style="color:var(--ink2)">→</span>
          <span class="link" data-action="cust.selectAndRender" data-cust-id="${window.escAttr(c.mergedInto)}" style="color:var(--purple);font-weight:500">${window.escHtml(c.mergedInto)}</span>
          <span style="color:var(--ink3);font-family:'DM Mono',monospace;font-size:10px">on ${window.escHtml(c.mergedAt || '—')}</span>
          ${admin ? `<button class="btn btn-sm" style="margin-left:auto" data-action="cust.unmerge" data-cust-id="${window.escAttr(c.id)}">Un-merge</button>` : ''}
        </div>` : ''}
        ${(c.mergedFrom || []).length ? `<div class="card" style="margin-bottom:16px">
          <div class="card-title">Merged duplicates (${c.mergedFrom.length})</div>
          ${c.mergedFrom.map(mid => {
            const m = CUSTOMERS.find(x => x.id === mid);
            if (!m) return '';
            return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--rule);cursor:pointer" data-action="cust.selectAndRender" data-cust-id="${window.escAttr(mid)}">
              <div style="width:24px;height:24px;border-radius:50%;background:var(--ink);color:var(--w);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600">${window.escHtml((m.first[0]||'') + (m.last[0]||''))}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:12px;color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.escHtml(m.first + ' ' + m.last)}</div>
                <div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${window.escHtml(mid)} · merged ${window.escHtml(m.mergedAt || '—')}</div>
              </div>
            </div>`;
          }).join('')}
        </div>` : ''}
        <div class="cust-quickactions">
          <a href="mailto:${c.email}" class="btn btn-sm">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="2.5" width="10" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 3l4.5 3.5L10.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Email
          </a>
          <a href="tel:${c.mobile.replace(/\s/g,'')}" class="btn btn-sm">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 1.5h2l1 2.5L3.5 5a8 8 0 0 0 3.5 3.5L8.5 7l2.5 1V11a1 1 0 0 1-1 1A9 9 0 0 1 1 2.5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
            Call
          </a>
          <button class="btn btn-sm" data-action="cust.addNote" data-cust-id="${window.escAttr(c.id)}">+ Note</button>
          ${c.bo ? `<a href="${c.bo}" target="_blank" rel="noopener" class="btn btn-sm">Backoffice ↗</a>` : ''}
          ${admin && !c.mergedInto ? `<button class="btn btn-sm" data-action="cust.showMergeModal" data-cust-id="${window.escAttr(c.id)}">↩ Merge</button>` : ''}
          <button class="btn btn-sm btn-danger" style="margin-left:auto" data-action="cust.showGdpr" data-cust-id="${window.escAttr(c.id)}">GDPR</button>
        </div>
        ${riskPanel}
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${s.open}</div><div class="r-tile-l" style="color:var(--cyan)">Open</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${s.total}</div><div class="r-tile-l" style="color:var(--ink3)">Total tickets</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${s.csatCount?s.avgCSAT.toFixed(1):'—'}</div><div class="r-tile-l" style="color:var(--amber)">CSAT (${s.csatCount})</div></div>
          <div class="r-tile" style="border-color:${c.consent?'rgba(52,211,153,0.3)':'rgba(248,113,113,0.3)'};background:${c.consent?'var(--green-lt)':'var(--red-lt)'}"><div class="r-tile-n" style="color:${c.consent?'var(--green)':'var(--red)'};font-size:18px;line-height:1.2">${c.consent?'Yes':'No'}</div><div class="r-tile-l" style="color:${c.consent?'var(--green)':'var(--red)'}">Consent</div></div>
        </div>
        ${tagsBlock}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card">
            <div class="card-title">Profile</div>
            ${isFieldVisible('customer','email')        ? `<div class="ts-row"><span class="ts-key">Email</span><span class="ts-val">${window.escHtml(c.email)}${renderBounceBadge(c)}</span></div>` : ''}
            ${isFieldVisible('customer','mobile')       ? `<div class="ts-row"><span class="ts-key">Mobile</span><span class="ts-val">${window.escHtml(c.mobile)}</span></div>` : ''}
            ${isFieldVisible('customer','username')     ? `<div class="ts-row"><span class="ts-key">Username</span><span class="ts-val" style="font-family:'DM Mono',monospace;font-size:12px">${window.escHtml(c.username)}</span></div>` : ''}
            ${isFieldVisible('customer','brand')        ? `<div class="ts-row"><span class="ts-key">Brand</span><span class="ts-val">${window.escHtml(c.brand)}</span></div>` : ''}
            ${isFieldVisible('customer','vip')          ? `<div class="ts-row"><span class="ts-key">VIP tier</span><span class="vip-badge vip-${(c.vip||'').toLowerCase()}">${window.escHtml(c.vip)}</span></div>` : ''}
            ${isFieldVisible('customer','jurisdiction') ? `<div class="ts-row"><span class="ts-key">Jurisdiction</span><span class="ts-val">${window.escHtml(c.jurisdiction)}</span></div>` : ''}
            ${isFieldVisible('customer','kyc')          ? `<div class="ts-row"><span class="ts-key">KYC</span><span class="ts-val">${window.escHtml(c.kyc)}</span></div>` : ''}
            ${isFieldVisible('customer','since')        ? `<div class="ts-row"><span class="ts-key">Customer since</span><span class="ts-val">${window.escHtml(c.since)}</span></div>` : ''}
          </div>
          <div class="card">
            <div class="card-title">Custom fields</div>
            ${customFields}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          ${timelineBlock}
          ${notesBlock}
        </div>
        <div class="card">
          <div class="card-title">Tickets</div>
          ${s.tickets.length ? `
            <table class="tbl">
              <thead><tr><th>ID</th><th>Subject</th><th>Status</th><th>Priority</th><th>Agent</th><th>SLA</th><th>Updated</th></tr></thead>
              <tbody>${ticketRows}</tbody>
            </table>
          ` : `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tickets</div><div class="empty-line"></div></div>`}
        </div>
      </div>
    </div>`;
}

registerActions({
  // List + bulk actions
  'cust.openProfile':     (ds) => openCustomerProfile(ds.custId),
  'cust.closeProfile':    () => closeCustomerProfile(),
  'cust.setView':         (ds) => setCustView(ds.view),
  'cust.bulkDelete':      () => bulkDeleteCustomers(),
  'cust.clearSelection':  () => clearCustSelection(),
  'cust.showColumnPanel': () => showColumnPanel(),
  'cust.manageFields':    () => showManageFieldsModal(),
  // Direct imports despite the customers↔customers/modals.js cycle — the
  // openers are only referenced inside these closures. See header.
  'cust.csvImport':       () => showCSVModal(),
  'cust.new':             () => showNewCustomerModal(),
  'cust.export':          () => exportCustomerList(),
  'cust.closeGdpr':       () => closeModal(),
  // Detail-page actions
  'cust.openTicket':      (ds) => openTicket(ds.ticketId),
  'cust.addNote':         (ds) => addCustomerNote(ds.custId),
  'cust.deleteNote':      (ds) => deleteCustomerNote(ds.custId, parseInt(ds.noteIdx, 10)),
  'cust.unmerge':         (ds) => unmergeCustomer(ds.custId),
  'cust.showMergeModal':  (ds) => showMergeCustomerModal(ds.custId),
  'cust.showGdpr':        (ds) => showCustomerGDPR(ds.custId),
  // Switch the active customer + re-render — used by the
  // mergedInto link and the per-original-customer list items in the
  // un-merge undo block.
  'cust.selectAndRender': (ds) => { setCustomerSelected(ds.custId); renderPage('customers'); },
});

registerChangeActions({
  'cust.toggleSelected': (ds) => toggleCustSelected(ds.custId),
  'cust.toggleAll':      () => toggleAllCustomers(),
  'cust.toggleCol':      (ds, el) => { CUST_COLUMNS[parseInt(ds.colIdx, 10)].visible = el.checked; refreshCustTable(CUSTOMERS); },
  'cust.bulkSetVIP':     (ds, el) => bulkSetCustVIP(el.value),
  'cust.bulkSetConsent': (ds, el) => bulkSetCustConsent(el.value),
  'cust.setVIP':         (ds, el) => custSetVIP(el.value),
  'cust.setBrand':       (ds, el) => custSetBrand(el.value),
  'cust.setGroupBy':     (ds, el) => setCustGroupBy(el.value),
});

registerInputActions({
  'cust.filter':      (ds, el) => filterCustomers(el.value),
  'cust.updateField': (ds, el) => updateCustomField(ds.custId, ds.fieldId, el.value),
});

registerMousedownActions({
  // Pick a primary in the merge modal: close it, then merge.
  'cust.mergeFromModal': (ds) => { closeModal(); mergeCustomers(ds.source, ds.target); },
});

// ─── Column drag-and-drop dispatcher ─────────────────────────────────────────
// Drag is sparse — only this module + widget-shell use it across the
// codebase — so it lives here rather than in core/event-delegation.js. The
// selector `th[draggable="true"]` disambiguates from widget-shell's
// `.widget[draggable="true"]`, so both modules' document-level listeners
// coexist without stepping on each other.
function _dragTh(e) { return e.target.closest('th[draggable="true"]'); }
document.addEventListener('dragstart', e => {
  const th = _dragTh(e); if (!th) return;
  setCustDragCol(parseInt(th.dataset.colIdx, 10));
});
document.addEventListener('dragover', e => {
  const th = _dragTh(e); if (!th) return;
  e.preventDefault();
});
document.addEventListener('drop', e => {
  const th = _dragTh(e); if (!th) return;
  dropCustCol(parseInt(th.dataset.colIdx, 10));
});
