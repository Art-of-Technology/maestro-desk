// ─── Tags ────────────────────────────────────────────────────────────────────
// Config-section page that owns the tag library: list with bulk select/sort,
// per-tag detail breakdown (status / priority / brand / top customers /
// tickets using it), and CRUD with normalization, merge, and AI-or-Manual
// type conversion.
//
// External reaches (interim, via window): isAdmin, escAttr, escHtml,
// showModal, closeModal, renderPage, openTicket, navTo — all still in app.js.
//
// TAG_LIBRARY, TICKETS, CUSTOMERS come from data.js via the global lexical
// env; TAG_SELECTED, TAG_FILTER_TYPE, TAG_QUERY, TAG_SELECTED_NAMES,
// TAG_SORT_COL, TAG_SORT_DIR, CUSTOMER_SELECTED come from core/state.js
// the same way.

import { STATUS_COLORS, PRIORITY_COLORS } from '../core/colors.js';

export function renderTags() {
  if (TAG_SELECTED) return renderTagDetail(TAG_SELECTED);
  const admin = window.isAdmin();
  const list = applyTagFilters();
  const total = TAG_LIBRARY.length;
  const manualN = TAG_LIBRARY.filter(t => t.type === 'manual').length;
  const aiN = TAG_LIBRARY.filter(t => t.type === 'ai').length;
  const aiWithConf = TAG_LIBRARY.filter(t => t.type === 'ai' && t.conf);
  const avgConf = aiWithConf.length ? Math.round(aiWithConf.reduce((a, t) => a + t.conf, 0) / aiWithConf.length) : 0;
  const totalUsage = TAG_LIBRARY.reduce((a, t) => a + t.count, 0);
  const max = Math.max(...TAG_LIBRARY.map(x => x.count), 1);

  const allSelected = list.length > 0 && list.every(t => TAG_SELECTED_NAMES.has(t.tag));
  const sortIndicator = col => TAG_SORT_COL === col ? (TAG_SORT_DIR === 1 ? ' ↑' : ' ↓') : '';

  const rows = list.map(t => {
    const pct = (t.count / max) * 100;
    const confColor = t.conf
      ? (t.conf >= 90 ? 'var(--green)' : t.conf >= 80 ? 'var(--amber)' : 'var(--red)')
      : 'var(--ink4)';
    const checked = TAG_SELECTED_NAMES.has(t.tag);
    return `
      <tr style="cursor:pointer${checked?';background:var(--purple-lt)':''}" onclick="openTagDetail('${window.escAttr(t.tag)}')">
        <td style="width:32px;padding-right:0" onclick="event.stopPropagation()">
          <input type="checkbox" ${checked?'checked':''} onchange="toggleTagSelected('${window.escAttr(t.tag)}')" style="cursor:pointer;accent-color:var(--purple)" />
        </td>
        <td><span class="tag tag-neutral" style="font-size:11px">${t.tag}</span></td>
        <td>${t.type === 'ai'
          ? '<span class="tag tag-resolved" style="font-size:10px">AI</span>'
          : '<span class="tag tag-neutral" style="font-size:10px">Manual</span>'}</td>
        <td style="font-family:'DM Mono',monospace;font-size:12px;color:${confColor}">${t.conf ? t.conf + '%' : '—'}</td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-family:'DM Mono',monospace;font-size:12px;width:28px;color:var(--ink2)">${t.count}</div>
            <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden;max-width:160px"><div style="background:var(--purple);height:100%;width:${pct}%"></div></div>
          </div>
        </td>
        ${admin ? `<td style="text-align:right;white-space:nowrap" onclick="event.stopPropagation()">
          <button class="btn btn-sm" onclick="convertTagType('${window.escAttr(t.tag)}')" title="Convert AI ↔ Manual">${t.type==='ai'?'→ Manual':'→ AI'}</button>
          <button class="btn btn-sm" onclick="mergeTagPrompt('${window.escAttr(t.tag)}')">Merge</button>
          <button class="btn btn-sm" onclick="tagEdit('${window.escAttr(t.tag)}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="tagDelete('${window.escAttr(t.tag)}')">Delete</button>
        </td>` : ''}
      </tr>`;
  }).join('');

  const bulkBar = TAG_SELECTED_NAMES.size > 0 ? `
    <div style="padding:8px 20px;border-bottom:1px solid var(--rule);background:var(--purple-lt);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--purple);font-weight:600">${TAG_SELECTED_NAMES.size} selected</span>
      <select class="filter-select" onchange="bulkSetTagType(this.value)">
        <option value="">Set type…</option>
        <option value="manual">Manual</option>
        <option value="ai">AI-suggested</option>
      </select>
      <button class="btn btn-sm btn-danger" onclick="bulkDeleteTags()">Delete</button>
      <button class="btn btn-sm" onclick="clearTagSelection()" style="margin-left:auto">Clear selection</button>
    </div>` : '';

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Tags</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" onclick="tagNew()">+ New Tag</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total tags</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${manualN}</div><div class="kpi-l">Manual</div></div>
        <div class="kpi"><div class="kpi-n c-green">${aiN}</div><div class="kpi-l">AI-suggested</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${avgConf ? avgConf + '%' : '—'}</div><div class="kpi-l">Avg AI confidence</div></div>
      </div>
      ${bulkBar}
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" id="tag-search" placeholder="Search tags…" style="width:200px" value="${TAG_QUERY}" oninput="tagSetQuery(this.value)"/>
        <select class="filter-select" onchange="tagSetType(this.value)">
          <option value="all"    ${TAG_FILTER_TYPE==='all'?'selected':''}>All types</option>
          <option value="manual" ${TAG_FILTER_TYPE==='manual'?'selected':''}>Manual</option>
          <option value="ai"     ${TAG_FILTER_TYPE==='ai'?'selected':''}>AI-suggested</option>
        </select>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total} · ${totalUsage} total uses</span>
      </div>
      <div style="flex:1;overflow-y:auto">
        <table class="tbl">
          <thead><tr>
            <th style="width:32px;padding-right:0" onclick="event.stopPropagation()">
              <input type="checkbox" ${allSelected?'checked':''} onchange="toggleAllTags()" style="cursor:pointer;accent-color:var(--purple)" title="Select all in view"/>
            </th>
            <th onclick="setTagSort('tag')" style="cursor:pointer;user-select:none">Tag${sortIndicator('tag')}</th>
            <th onclick="setTagSort('type')" style="cursor:pointer;user-select:none">Type${sortIndicator('type')}</th>
            <th onclick="setTagSort('conf')" style="cursor:pointer;user-select:none">Confidence${sortIndicator('conf')}</th>
            <th onclick="setTagSort('count')" style="cursor:pointer;user-select:none">Usage${sortIndicator('count')}</th>
            ${admin ? '<th style="text-align:right">Actions</th>' : ''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length === 0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tags match</div><div class="empty-line"></div></div>` : ''}
      </div>
    </div>`;
}

function applyTagFilters() {
  let list = [...TAG_LIBRARY];
  if (TAG_FILTER_TYPE !== 'all') list = list.filter(t => t.type === TAG_FILTER_TYPE);
  if (TAG_QUERY.trim()) {
    const q = TAG_QUERY.toLowerCase();
    list = list.filter(t => t.tag.toLowerCase().includes(q));
  }
  list.sort((a, b) => {
    let av = a[TAG_SORT_COL] ?? '', bv = b[TAG_SORT_COL] ?? '';
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (typeof av === 'string') return av.localeCompare(bv) * TAG_SORT_DIR;
    return ((av || 0) - (bv || 0)) * TAG_SORT_DIR;
  });
  return list;
}

export function setTagSort(col) {
  if (TAG_SORT_COL === col) TAG_SORT_DIR *= -1;
  else { TAG_SORT_COL = col; TAG_SORT_DIR = col === 'tag' ? 1 : -1; }
  window.renderPage('tags');
}

export function openTagDetail(tag) { TAG_SELECTED = tag; window.renderPage('tags'); }
export function closeTagDetail()   { TAG_SELECTED = null; window.renderPage('tags'); }

export function toggleTagSelected(tag) {
  if (TAG_SELECTED_NAMES.has(tag)) TAG_SELECTED_NAMES.delete(tag);
  else TAG_SELECTED_NAMES.add(tag);
  window.renderPage('tags');
}
export function toggleAllTags() {
  const ids = applyTagFilters().map(t => t.tag);
  const all = ids.length > 0 && ids.every(id => TAG_SELECTED_NAMES.has(id));
  if (all) ids.forEach(id => TAG_SELECTED_NAMES.delete(id));
  else ids.forEach(id => TAG_SELECTED_NAMES.add(id));
  window.renderPage('tags');
}
export function clearTagSelection() { TAG_SELECTED_NAMES.clear(); window.renderPage('tags'); }

export function bulkSetTagType(v) {
  if (!window.isAdmin() || !v || TAG_SELECTED_NAMES.size === 0) return;
  TAG_LIBRARY.forEach(t => {
    if (TAG_SELECTED_NAMES.has(t.tag)) {
      t.type = v;
      if (v === 'manual') t.conf = null;
      else if (v === 'ai' && !t.conf) t.conf = 90;
    }
  });
  TAG_SELECTED_NAMES.clear();
  window.renderPage('tags');
}
export function bulkDeleteTags() {
  if (!window.isAdmin()) return;
  const n = TAG_SELECTED_NAMES.size;
  if (n === 0) return;
  window.showModal(`Delete ${n} tag${n===1?'':'s'}`, `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${n}</strong> tag${n===1?'':'s'}? They will be removed from any tickets currently using them.</div>`, () => {
    [...TAG_SELECTED_NAMES].forEach(tagName => {
      TICKETS.forEach(tk => {
        tk.tags = (tk.tags || []).filter(x => x !== tagName);
        tk.aiTags = (tk.aiTags || []).filter(at => at.tag !== tagName);
      });
      const i = TAG_LIBRARY.findIndex(x => x.tag === tagName);
      if (i >= 0) TAG_LIBRARY.splice(i, 1);
    });
    TAG_SELECTED_NAMES.clear();
    window.closeModal();
    window.renderPage('tags');
  }, 'Delete');
}

export function convertTagType(tagName) {
  if (!window.isAdmin()) return;
  const t = TAG_LIBRARY.find(x => x.tag === tagName);
  if (!t) return;
  if (t.type === 'ai') { t.type = 'manual'; t.conf = null; }
  else                 { t.type = 'ai'; t.conf = t.conf || 90; }
  window.renderPage('tags');
}

export function mergeTagPrompt(sourceName) {
  if (!window.isAdmin()) return;
  const candidates = TAG_LIBRARY.filter(t => t.tag !== sourceName);
  window.showModal(`Merge "${sourceName}" into…`, `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;line-height:1.5">All tickets using <strong style="color:var(--ink)">${sourceName}</strong> will be re-tagged with the target. The source tag will be deleted.</div>
    <div style="max-height:380px;overflow-y:auto">
      ${candidates.length ? candidates.map(t => `
        <div onmousedown="closeModal();mergeTags('${window.escAttr(sourceName)}','${window.escAttr(t.tag)}')" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
          <span class="tag tag-neutral" style="font-size:11px">${t.tag}</span>
          <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-left:auto">${t.count} use${t.count===1?'':'s'}</span>
        </div>`).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No other tags to merge into</div>'}
    </div>
  `, null, null);
}

export function mergeTags(sourceName, targetName) {
  const source = TAG_LIBRARY.find(x => x.tag === sourceName);
  const target = TAG_LIBRARY.find(x => x.tag === targetName);
  if (!source || !target) return;
  TICKETS.forEach(tk => {
    tk.tags = [...new Set((tk.tags || []).map(x => x === sourceName ? targetName : x))];
    tk.aiTags = (tk.aiTags || []).map(at => at.tag === sourceName ? { ...at, tag: targetName } : at);
  });
  target.count = (target.count || 0) + (source.count || 0);
  const i = TAG_LIBRARY.findIndex(x => x.tag === sourceName);
  if (i >= 0) TAG_LIBRARY.splice(i, 1);
  if (TAG_SELECTED === sourceName) TAG_SELECTED = targetName;
  window.renderPage('tags');
}

function renderTagDetail(tagName) {
  const t = TAG_LIBRARY.find(x => x.tag === tagName);
  if (!t) { TAG_SELECTED = null; return renderTags(); }
  const admin = window.isAdmin();
  const using = TICKETS.filter(tk => (tk.tags || []).includes(tagName) || (tk.aiTags || []).some(at => at.tag === tagName));
  const customerIds = new Set(using.map(tk => tk.customerId));

  const byStatus = {};
  using.forEach(tk => byStatus[tk.status] = (byStatus[tk.status] || 0) + 1);
  const byPriority = {};
  using.forEach(tk => byPriority[tk.priority] = (byPriority[tk.priority] || 0) + 1);
  const custCounts = {};
  using.forEach(tk => custCounts[tk.customerId] = (custCounts[tk.customerId] || 0) + 1);
  const topCustomers = Object.entries(custCounts)
    .map(([id, c]) => ({ cust: CUSTOMERS.find(x => x.id === id), count: c }))
    .filter(x => x.cust)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const byBrand = {};
  using.forEach(tk => {
    const cust = CUSTOMERS.find(c => c.id === tk.customerId);
    if (cust) byBrand[cust.brand] = (byBrand[cust.brand] || 0) + 1;
  });

  const statusVals = Object.values(byStatus);
  const statusMax = Math.max(...statusVals, 1);
  const statusBars = Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="font-size:11px;color:var(--ink2);width:80px;text-transform:capitalize">${k}</div><div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${STATUS_COLORS[k]||'var(--purple)'};height:100%;width:${(v/statusMax)*100}%"></div></div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);width:24px;text-align:right">${v}</div></div>`
  ).join('') || '<div style="color:var(--ink3);font-size:12px">No data</div>';

  const priMax = Math.max(...['urgent','high','normal','low'].map(p => byPriority[p] || 0), 1);
  const priBars = ['urgent','high','normal','low'].filter(p => byPriority[p]).map(k => {
    const v = byPriority[k];
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="font-size:11px;color:var(--ink2);width:80px;text-transform:capitalize">${k}</div><div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:${PRIORITY_COLORS[k]};height:100%;width:${(v/priMax)*100}%"></div></div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);width:24px;text-align:right">${v}</div></div>`;
  }).join('') || '<div style="color:var(--ink3);font-size:12px">No data</div>';

  const brandMax = Math.max(...Object.values(byBrand), 1);
  const brandBars = Object.entries(byBrand).sort((a, b) => b[1] - a[1]).map(([brand, count]) =>
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px"><div style="font-size:12px;color:var(--ink2);width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${brand}</div><div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--purple);height:100%;width:${(count/brandMax)*100}%"></div></div><div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:22px;text-align:right">${count}</div></div>`
  ).join('') || '<div style="color:var(--ink3);font-size:12px">No data</div>';

  const topCustRows = topCustomers.length ? topCustomers.map(({ cust, count }) => {
    const max = topCustomers[0].count;
    return `<div onclick="CUSTOMER_SELECTED='${window.escAttr(cust.id)}';navTo('customers')" style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer">
      <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${cust.first[0]}${cust.last[0]}</div>
      <div style="font-size:12px;color:var(--ink2);width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cust.first} ${cust.last}</div>
      <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--cyan);height:100%;width:${(count/max)*100}%"></div></div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:22px;text-align:right">${count}</div>
    </div>`;
  }).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:8px 0">No customers</div>';

  const ticketRows = using.map(tk => {
    const cust = CUSTOMERS.find(c => c.id === tk.customerId);
    return `<tr onclick="openTicket('${window.escAttr(tk.id)}')" style="cursor:pointer">
      <td class="bold">${tk.id}</td>
      <td>${cust ? cust.first + ' ' + cust.last : '—'}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tk.subject}</td>
      <td><span class="tag tag-${tk.status}">${tk.status}</span></td>
      <td><span class="tag tag-${tk.priority}">${tk.priority}</span></td>
      <td>${tk.agent || '—'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span onclick="closeTagDetail()">Tags</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${tagName}</span>
          ${admin ? `<span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-sm" onclick="convertTagType('${window.escAttr(tagName)}')">${t.type==='ai'?'Convert to manual':'Convert to AI'}</button>
            <button class="btn btn-sm" onclick="mergeTagPrompt('${window.escAttr(tagName)}')">Merge…</button>
            <button class="btn btn-sm" onclick="tagEdit('${window.escAttr(tagName)}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="tagDelete('${window.escAttr(tagName)}')">Delete</button>
          </span>` : ''}
        </div>
      </div>
      <div class="page-scroll">
        <div class="card" style="display:flex;gap:18px;align-items:center;padding:20px;margin-bottom:16px">
          <div style="width:54px;height:54px;border-radius:var(--r2);background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 12L11 4h8v8L11 20l-8-8z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/><circle cx="15" cy="9" r="1.5" fill="#fff"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
              <span class="tag tag-neutral" style="font-size:13px">${tagName}</span>
              ${t.type==='ai' ? '<span class="tag tag-resolved" style="font-size:10px">AI</span>' : '<span class="tag tag-neutral" style="font-size:10px">Manual</span>'}
            </div>
            <div style="font-size:13px;color:var(--ink3)">${t.count} use${t.count===1?'':'s'} · ${customerIds.size} customer${customerIds.size===1?'':'s'}${t.conf ? ' · ' + t.conf + '% confidence' : ''}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile" style="border-color:rgba(139,92,246,0.3);background:var(--purple-lt)"><div class="r-tile-n" style="color:var(--purple)">${using.length}</div><div class="r-tile-l" style="color:var(--purple)">Tickets</div></div>
          <div class="r-tile" style="border-color:rgba(34,211,238,0.3);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${customerIds.size}</div><div class="r-tile-l" style="color:var(--cyan)">Customers</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink);font-size:14px;text-transform:capitalize">${t.type === 'ai' ? 'AI-suggested' : 'Manual'}</div><div class="r-tile-l" style="color:var(--ink3)">Type</div></div>
          <div class="r-tile" style="border-color:rgba(251,191,36,0.3);background:var(--amber-lt)"><div class="r-tile-n" style="color:var(--amber)">${t.conf ? t.conf + '%' : '—'}</div><div class="r-tile-l" style="color:var(--amber)">Confidence</div></div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card"><div class="card-title">By status</div>${statusBars}</div>
          <div class="card"><div class="card-title">By priority</div>${priBars}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card"><div class="card-title">Top customers</div>${topCustRows}</div>
          <div class="card"><div class="card-title">By brand</div>${brandBars}</div>
        </div>

        <div class="card">
          <div class="card-title">Tickets using this tag</div>
          ${using.length ? `
            <table class="tbl">
              <thead><tr><th>ID</th><th>Customer</th><th>Subject</th><th>Status</th><th>Priority</th><th>Agent</th></tr></thead>
              <tbody>${ticketRows}</tbody>
            </table>
          ` : '<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No tickets using this tag</div><div class="empty-line"></div></div>'}
        </div>
      </div>
    </div>`;
}

export function tagSetType(v) { TAG_FILTER_TYPE = v; window.renderPage('tags'); }
export function tagSetQuery(v) {
  TAG_QUERY = v;
  window.renderPage('tags');
  const input = document.getElementById('tag-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

// Reads aren't currently called from anywhere — kept for parity with the
// historical "show usage in a modal" entry point. Safe to delete if no
// caller appears.
export function tagShowUsage(tagName) {
  const using = TICKETS.filter(t =>
    (t.tags || []).includes(tagName) ||
    (t.aiTags || []).some(at => at.tag === tagName)
  );
  const def = TAG_LIBRARY.find(t => t.tag === tagName);
  const items = using.length
    ? using.map(t => `
        <div onmousedown="closeModal();openTicket('${window.escAttr(t.id)}')" style="padding:10px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
          <span class="tag tag-${t.status}" style="font-size:10px">${t.status}</span>
          <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${t.id}</span>
          <span style="flex:1;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.subject}</span>
        </div>`).join('')
    : '<div style="font-size:12px;color:var(--ink3);text-align:center;padding:24px">No tickets currently use this tag</div>';
  window.showModal(`Tag: ${tagName}`, `
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--rule)">
      <span class="tag tag-neutral">${tagName}</span>
      ${def ? `<span style="font-size:11px;color:var(--ink3)">${def.type==='ai'?'AI-suggested':'Manual'}${def.conf?` · ${def.conf}% confidence`:''}</span>` : ''}
      <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${using.length} ticket${using.length===1?'':'s'}</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">${items}</div>
  `, null, null);
}

function tagFormBody(t) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-row"><label class="form-label">Tag name</label><input class="form-input" id="tag-name" value="${esc(t?.tag)}" placeholder="lowercase-with-dashes"/></div>
    <div class="form-row"><label class="form-label">Type</label>
      <select class="form-input" id="tag-type" onchange="document.getElementById('tag-conf-row').style.display = this.value === 'ai' ? 'block' : 'none'">
        <option value="manual" ${(!t || t.type==='manual')?'selected':''}>Manual</option>
        <option value="ai"     ${t?.type==='ai'?'selected':''}>AI-suggested</option>
      </select>
    </div>
    <div class="form-row" id="tag-conf-row" style="display:${t?.type==='ai'?'block':'none'}">
      <label class="form-label">Confidence (%)</label>
      <input class="form-input" id="tag-conf" type="number" min="0" max="100" value="${t?.conf||''}" placeholder="0–100"/>
    </div>`;
}

function normalizeTagName(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

export function tagNew() {
  if (!window.isAdmin()) return;
  window.showModal('New tag', tagFormBody(null), () => {
    const name = normalizeTagName(document.getElementById('tag-name').value);
    const type = document.getElementById('tag-type').value;
    const conf = type === 'ai' ? (parseInt(document.getElementById('tag-conf').value) || null) : null;
    if (!name || TAG_LIBRARY.find(t => t.tag === name)) return;
    TAG_LIBRARY.unshift({ tag: name, count: 0, type, conf });
    window.closeModal(); window.renderPage('tags');
  }, 'Create');
}

export function tagEdit(name) {
  if (!window.isAdmin()) return;
  const t = TAG_LIBRARY.find(x => x.tag === name); if (!t) return;
  window.showModal(`Edit tag`, tagFormBody(t), () => {
    const newName = normalizeTagName(document.getElementById('tag-name').value);
    const type = document.getElementById('tag-type').value;
    const conf = type === 'ai' ? (parseInt(document.getElementById('tag-conf').value) || null) : null;
    if (!newName) return;
    if (newName !== t.tag && TAG_LIBRARY.find(x => x.tag === newName)) return;
    if (newName !== t.tag) {
      TICKETS.forEach(tk => {
        tk.tags = (tk.tags || []).map(x => x === t.tag ? newName : x);
        tk.aiTags = (tk.aiTags || []).map(at => at.tag === t.tag ? { ...at, tag: newName } : at);
      });
    }
    t.tag = newName; t.type = type; t.conf = conf;
    window.closeModal(); window.renderPage('tags');
  }, 'Save');
}

export function tagDelete(name) {
  if (!window.isAdmin()) return;
  const t = TAG_LIBRARY.find(x => x.tag === name); if (!t) return;
  const inUse = TICKETS.filter(tk => (tk.tags||[]).includes(name) || (tk.aiTags||[]).some(at => at.tag === name)).length;
  window.showModal('Delete tag', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${name}</strong>?${inUse?` This tag is currently used by <strong style="color:var(--ink)">${inUse} ticket${inUse===1?'':'s'}</strong> — it will be removed from those tickets.`:''}</div>`, () => {
    TICKETS.forEach(tk => {
      tk.tags = (tk.tags || []).filter(x => x !== name);
      tk.aiTags = (tk.aiTags || []).filter(at => at.tag !== name);
    });
    const i = TAG_LIBRARY.findIndex(x => x.tag === name);
    if (i >= 0) TAG_LIBRARY.splice(i, 1);
    window.closeModal(); window.renderPage('tags');
  }, 'Delete');
}
