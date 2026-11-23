// ─── Tags ────────────────────────────────────────────────────────────────────
// Config-section page that owns the tag library: list with bulk select/sort,
// per-tag detail breakdown (status / priority / brand / top customers /
// tickets using it), and CRUD with normalization, merge, and merge undo.
//
// Click/change/input/mousedown handlers route through
// core/event-delegation.js. Pure-style onmouseover/onmouseout hover
// effects on the merge-target + ticket-row cards stay inline (per the
// PR #105 rule — they're `this.style.X = Y` only).
// `renderTags` is the only export consumed (app.js router).
//
// External reaches (interim, via window): isAdmin, escAttr — all still in
// app.js. showModal, closeModal, openTicket and navTo are direct ES imports.

import { CUSTOMERS, TAG_LIBRARY, TICKETS } from '../core/data.js';
import { TAG_QUERY, TAG_SELECTED, TAG_SELECTED_NAMES, TAG_SORT_COL, TAG_SORT_DIR, setCustomerSelected, setTagQuery, setTagSelected, setTagSortCol, setTagSortDir } from '../core/state.js';
import { renderPage } from '../core/router.js';
import { STATUS_COLORS, PRIORITY_COLORS } from '../core/colors.js';
import { registerActions, registerChangeActions, registerInputActions, registerMousedownActions } from '../core/event-delegation.js';
import { navTo } from '../core/keybindings.js';
import { openTicket } from '../tickets/detail.js';
import { apiGet, apiPatch, apiPost, apiDelete, getJwt, getWorkspaceId } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';

export function renderTags() {
  if (!getJwt()) TAG_LIBRARY.forEach(t => { t.count = TICKETS.filter(tk => (tk.tags || []).includes(t.tag)).length; });
  if (TAG_SELECTED) return renderTagDetail(TAG_SELECTED);
  const admin = window.isAdmin();
  const list = applyTagFilters();
  const total = TAG_LIBRARY.length;
  const totalUsage = TAG_LIBRARY.reduce((a, t) => a + t.count, 0);
  const max = Math.max(...TAG_LIBRARY.map(x => x.count), 1);

  const allSelected = list.length > 0 && list.every(t => TAG_SELECTED_NAMES.has(t.tag));
  const sortIndicator = col => TAG_SORT_COL === col ? (TAG_SORT_DIR === 1 ? ' ↑' : ' ↓') : '';

  const rows = list.map(t => {
    const pct = (t.count / max) * 100;
    const checked = TAG_SELECTED_NAMES.has(t.tag);
    return `
      <tr style="cursor:pointer${checked?';background:var(--purple-lt)':''}" data-action="tags.openDetail" data-tag="${window.escAttr(t.tag)}">
        <td style="width:32px;padding-right:0" data-action="">
          <input type="checkbox" ${checked?'checked':''} data-change-action="tags.toggleSelected" data-tag="${window.escAttr(t.tag)}" style="cursor:pointer;accent-color:var(--purple)" />
        </td>
        <td><span class="tag tag-neutral" style="font-size:11px">${t.tag}</span></td>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-family:'DM Mono',monospace;font-size:12px;width:28px;color:var(--ink2)">${t.count}</div>
            <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden;max-width:160px"><div style="background:var(--purple);height:100%;width:${pct}%"></div></div>
          </div>
        </td>
        ${admin ? `<td style="text-align:right;white-space:nowrap" data-action="">
          <button class="btn btn-sm" data-action="tags.mergePrompt" data-tag="${window.escAttr(t.tag)}">Merge</button>
          <button class="btn btn-sm" data-action="tags.edit" data-tag="${window.escAttr(t.tag)}">Edit</button>
          <button class="btn btn-sm btn-danger" data-action="tags.delete" data-tag="${window.escAttr(t.tag)}">Delete</button>
        </td>` : ''}
      </tr>`;
  }).join('');

  const bulkBar = TAG_SELECTED_NAMES.size > 0 ? `
    <div style="padding:8px 20px;border-bottom:1px solid var(--rule);background:var(--purple-lt);display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--purple);font-weight:600">${TAG_SELECTED_NAMES.size} selected</span>
      <button class="btn btn-sm btn-danger" data-action="tags.bulkDelete">Delete</button>
      <button class="btn btn-sm" data-action="tags.clearSelection" style="margin-left:auto">Clear selection</button>
    </div>` : '';

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Tags</div>
        ${admin
          ? `<button class="btn btn-sm" data-action="tags.history">Merge history</button><button class="btn btn-solid btn-sm" data-action="tags.new">+ New Tag</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total tags</div></div>
        <div class="kpi"><div class="kpi-n c-blue">${totalUsage}</div><div class="kpi-l">Applied ticket tags</div></div>
      </div>
      <div style="padding:12px 20px;font-size:12px;color:var(--ink3)">Agents and AI use the same tag library. Suggestions count as usage once applied to a ticket.</div>
      ${bulkBar}
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" id="tag-search" placeholder="Search tags…" style="width:200px" value="${TAG_QUERY}" data-input-action="tags.setQuery"/>
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total} · ${totalUsage} total uses</span>
      </div>
      <div style="flex:1;overflow-y:auto">
        <table class="tbl">
          <thead><tr>
            <th style="width:32px;padding-right:0" data-action="">
              <input type="checkbox" ${allSelected?'checked':''} data-change-action="tags.toggleAll" style="cursor:pointer;accent-color:var(--purple)" title="Select all in view"/>
            </th>
            <th data-action="tags.setSort" data-col="tag" style="cursor:pointer;user-select:none">Tag${sortIndicator('tag')}</th>
            <th data-action="tags.setSort" data-col="count" style="cursor:pointer;user-select:none">Usage${sortIndicator('count')}</th>
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

function setTagSort(col) {
  if (TAG_SORT_COL === col) setTagSortDir(TAG_SORT_DIR * (-1));
  else { setTagSortCol(col); setTagSortDir(col === 'tag' ? 1 : -1); }
  renderPage('tags');
}

function openTagDetail(tag) { setTagSelected(tag); renderPage('tags'); }
function closeTagDetail()   { setTagSelected(null); renderPage('tags'); }

function toggleTagSelected(tag) {
  if (TAG_SELECTED_NAMES.has(tag)) TAG_SELECTED_NAMES.delete(tag);
  else TAG_SELECTED_NAMES.add(tag);
  renderPage('tags');
}
function toggleAllTags() {
  const ids = applyTagFilters().map(t => t.tag);
  const all = ids.length > 0 && ids.every(id => TAG_SELECTED_NAMES.has(id));
  if (all) ids.forEach(id => TAG_SELECTED_NAMES.delete(id));
  else ids.forEach(id => TAG_SELECTED_NAMES.add(id));
  renderPage('tags');
}
function clearTagSelection() { TAG_SELECTED_NAMES.clear(); renderPage('tags'); }

function tagsApiBacked() { return !!getJwt(); }

function bulkDeleteTags() {
  if (!window.isAdmin()) return;
  const n = TAG_SELECTED_NAMES.size;
  if (n === 0) return;
  showModal(`Delete ${n} tag${n===1?'':'s'}`, `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${n}</strong> tag${n===1?'':'s'}? They will be removed from any tickets currently using them.</div>`, async () => {
    const names = [...TAG_SELECTED_NAMES];
    if (tagsApiBacked()) {
      try {
        await Promise.all(names.map((n) =>
          apiDelete(`/api/v1/tags/${encodeURIComponent(n)}`)
        ));
      } catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
    }
    names.forEach(tagName => {
      TICKETS.forEach(tk => {
        tk.tags = (tk.tags || []).filter(x => x !== tagName);
        tk.aiTags = (tk.aiTags || []).filter(at => at.tag !== tagName);
      });
      const i = TAG_LIBRARY.findIndex(x => x.tag === tagName);
      if (i >= 0) TAG_LIBRARY.splice(i, 1);
    });
    TAG_SELECTED_NAMES.clear();
    closeModal();
    renderPage('tags');
  }, 'Delete');
}


function mergeTagPrompt(sourceName) {
  if (!window.isAdmin()) return;
  const candidates = TAG_LIBRARY.filter(t => t.tag !== sourceName);
  showModal(`Merge "${sourceName}" into…`, `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:12px;line-height:1.5">All tickets using <strong style="color:var(--ink)">${window.escHtml(sourceName)}</strong> will be re-tagged with the target. The source tag will be deleted.</div>
    <div style="max-height:380px;overflow-y:auto">
      ${candidates.length ? candidates.map(t => `
        <div data-mousedown-action="tags.mergeFromModal" data-source="${window.escAttr(sourceName)}" data-target="${window.escAttr(t.tag)}" style="padding:9px 12px;border:1px solid var(--rule);border-radius:var(--r);cursor:pointer;display:flex;gap:10px;align-items:center;background:var(--off2);margin-bottom:6px;transition:all .15s" onmouseover="this.style.borderColor='var(--purple)';this.style.background='var(--purple-lt)'" onmouseout="this.style.borderColor='var(--rule)';this.style.background='var(--off2)'">
          <span class="tag tag-neutral" style="font-size:11px">${window.escHtml(t.tag)}</span>
          <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);margin-left:auto">${t.count} use${t.count===1?'':'s'}</span>
        </div>`).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:18px 0">No other tags to merge into</div>'}
    </div>
  `, null, null);
}

async function mergeTags(sourceName, targetName) {
  if (!window.isAdmin()) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  const source = TAG_LIBRARY.find(x => x.tag === sourceName);
  const target = TAG_LIBRARY.find(x => x.tag === targetName);
  if (!source || !target) return;
  let targetCount;
  if (tagsApiBacked()) {
    try { targetCount = (await apiPost(`/api/v1/tags/${encodeURIComponent(sourceName)}/merge`, { into: targetName })).target_count; }
    catch (err) { alert(`Couldn't merge: ${err?.message || err}`); return; }
  }
  if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
  TICKETS.forEach(tk => {
    tk.tags = [...new Set((tk.tags || []).map(x => x === sourceName ? targetName : x))];
    const hadTarget = (tk.aiTags || []).some(at => at.tag === targetName);
    tk.aiTags = (tk.aiTags || []).filter(at => !hadTarget || at.tag !== sourceName).map(at => at.tag === sourceName ? { ...at, tag: targetName } : at);
    tk._detailLoaded = false;
  });
  target.count = targetCount ?? ((target.count || 0) + (source.count || 0));
  const i = TAG_LIBRARY.findIndex(x => x.tag === sourceName);
  if (i >= 0) TAG_LIBRARY.splice(i, 1);
  if (TAG_SELECTED === sourceName) setTagSelected(targetName);
  renderPage('tags');
}

async function showTagMergeHistory() {
  if (!window.isAdmin()) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  showModal('Merge history', '<div id="tag-merge-history" role="status" style="overflow-wrap:anywhere">Loading merges…</div>', null);
  const host = document.getElementById('tag-merge-history');
  if (!jwt) { host.textContent = 'Merge history is available in a connected workspace.'; return; }
  try {
    const { merges } = await apiGet('/api/v1/tags/merges');
    if (!host.isConnected || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    host.innerHTML = '<p>Only merges recorded after undo became available appear here. Later edits may prevent an undo.</p>' +
      (merges.length ? merges.map(m => `<div style="padding:12px 0;border-bottom:1px solid var(--rule)">
        <div><strong>${window.escHtml(m.source)}</strong> → <strong>${window.escHtml(m.target)}</strong></div>
        <div style="margin:6px 0">${window.escHtml(new Date(m.created_at).toLocaleString())}</div>
        ${m.undone_at ? '<span>Undone</span>' : `<button class="btn btn-sm" data-action="tags.undoMerge" data-id="${window.escAttr(m.id)}" data-source="${window.escAttr(m.source)}" data-target="${window.escAttr(m.target)}">Undo merge</button>`}
      </div>`).join('') : '<p>No recorded merges yet.</p>');
  } catch (err) { if (host.isConnected) host.textContent = "Couldn't load merges: " + err.message; }
}

function undoTagMerge({ id, source, target }) {
  if (!window.isAdmin()) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  let saving = false;
  showModal('Undo merge', `<p>Restore <strong>${window.escHtml(source)}</strong> and its original ticket assignments from the merge into <strong>${window.escHtml(target)}</strong>?</p>
    <p>If affected tags have changed since the merge, nothing will be changed.</p><p id="tag-undo-error" role="status"></p>`, async () => {
    if (saving || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    saving = true; button.disabled = true;
    try {
      const result = await apiPost('/api/v1/tags/merges/' + encodeURIComponent(id) + '/undo', {});
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
      for (const row of result.assignments) {
        const ticket = TICKETS.find(t => t._uuid === row.ticket_id);
        if (!ticket) continue;
        if (row.kind === 'manual') {
          ticket.tags = [...new Set((ticket.tags || []).filter(t => row.had_target || t !== result.target).concat(result.source))];
        } else {
          ticket.aiTags = (ticket.aiTags || []).filter(t => row.had_target || t.tag !== result.target);
          ticket.aiTags.push({ tag: result.source, conf: row.source_confidence, accepted: row.source_accepted });
        }
        ticket._detailLoaded = false;
      }
      // The undo succeeded even if refreshing counts fails; never offer to submit it again.
      status.textContent = 'Merge undone. Refreshing tags…';
      try {
        const response = await apiGet('/api/v1/tags');
        if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
        TAG_LIBRARY.splice(0, TAG_LIBRARY.length, ...response.tags.map(t => ({ tag: t.tag, type: t.kind, conf: t.ai_confidence, count: t.count })));
      } catch { status.textContent = 'Merge undone. Reload the Tags page to refresh the list.'; return; }
      if (status.isConnected) { closeModal(); renderPage('tags'); }
    } catch (err) {
      if (status.isConnected) status.textContent = err.message;
      saving = false; if (button.isConnected) button.disabled = false;
    }
  }, 'Undo merge');
  const status = document.getElementById('tag-undo-error');
  const button = document.querySelector('#modal-container [data-action="modal.confirm"]');
}

function renderTagDetail(tagName) {
  const t = TAG_LIBRARY.find(x => x.tag === tagName);
  if (!t) { setTagSelected(null); return renderTags(); }
  const admin = window.isAdmin();
  const using = TICKETS.filter(tk => (tk.tags || []).includes(tagName));
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
    return `<div data-action="tags.openCustomer" data-cust-id="${window.escAttr(cust.id)}" style="display:flex;align-items:center;gap:8px;margin-bottom:7px;cursor:pointer">
      <div style="width:22px;height:22px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;flex-shrink:0">${cust.first[0]}${cust.last[0]}</div>
      <div style="font-size:12px;color:var(--ink2);width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cust.first} ${cust.last}</div>
      <div style="flex:1;background:var(--off2);height:6px;border-radius:3px;overflow:hidden"><div style="background:var(--cyan);height:100%;width:${(count/max)*100}%"></div></div>
      <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);width:22px;text-align:right">${count}</div>
    </div>`;
  }).join('') : '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:8px 0">No customers</div>';

  const ticketRows = using.map(tk => {
    const cust = CUSTOMERS.find(c => c.id === tk.customerId);
    return `<tr data-action="tags.openTicket" data-ticket-id="${window.escAttr(tk.id)}" style="cursor:pointer">
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
          <span data-action="tags.closeDetail">Tags</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${tagName}</span>
          ${admin ? `<span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-sm" data-action="tags.mergePrompt" data-tag="${window.escAttr(tagName)}">Merge…</button>
            <button class="btn btn-sm" data-action="tags.edit" data-tag="${window.escAttr(tagName)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-action="tags.delete" data-tag="${window.escAttr(tagName)}">Delete</button>
          </span>` : ''}
        </div>
      </div>
      <div class="page-scroll">
        <div class="card" style="display:flex;gap:18px;align-items:center;padding:20px;margin-bottom:16px">
          <div style="width:54px;height:54px;border-radius:var(--r2);background:var(--ink);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 12L11 4h8v8L11 20l-8-8z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/><circle cx="15" cy="9" r="1.5" fill="#fff"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
              <span class="tag tag-neutral" style="font-size:13px">${tagName}</span>
            </div>
            <div style="font-size:13px;color:var(--ink3)">Applied to ${t.count} ticket${t.count===1?'':'s'}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile" style="border-color:var(--rule3);background:var(--purple-lt)"><div class="r-tile-n" style="color:var(--purple)">${t.count}</div><div class="r-tile-l" style="color:var(--purple)">Tickets</div></div>
          <div class="r-tile" style="border-color:var(--cyan-bd);background:var(--cyan-lt)"><div class="r-tile-n" style="color:var(--cyan)">${customerIds.size}</div><div class="r-tile-l" style="color:var(--cyan)">Customers in this list</div></div>
        </div>
        <p style="font-size:12px;color:var(--ink3)">The breakdowns below cover ${using.length} currently loaded ticket${using.length===1?'':'s'}. The usage count includes all tickets.</p>

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

function tagSetQuery(v) {
  setTagQuery(v);
  renderPage('tags');
  const input = document.getElementById('tag-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function tagFormBody(t) {
  return `
    <div class="form-row"><label class="form-label" for="tag-name">Tag name</label><input class="form-input" id="tag-name" value="${window.escAttr(t?.tag || '')}" placeholder="lowercase-with-dashes"/></div>`;
}

function normalizeTagName(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function tagNew() { tagOpen(null); }
function tagEdit(name) { const t = TAG_LIBRARY.find(x => x.tag === name); if (t) tagOpen(t); }
function tagOpen(t) {
  if (!window.isAdmin()) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  let saving = false;
  showModal(t ? 'Edit tag' : 'New tag', tagFormBody(t) + '<p id="tag-error" role="status"></p>', async () => {
    if (saving || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    const name = normalizeTagName(input.value);
    if (!name || name.length > 64) { status.textContent = 'Enter a tag name of up to 64 characters.'; return; }
    if (TAG_LIBRARY.some(x => x !== t && x.tag === name)) { status.textContent = 'This tag already exists.'; return; }
    saving = true; button.disabled = true;
    try {
      const body = { tag: name };
      const saved = jwt ? (t ? await apiPatch('/api/v1/tags/' + encodeURIComponent(t.tag), body)
        : await apiPost('/api/v1/tags', body)).tag : { tag: name, kind: t?.type || 'manual', ai_confidence: t?.conf ?? null };
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
      if (t) {
        const oldName = t.tag;
        TICKETS.forEach(tk => {
          tk.tags = (tk.tags || []).map(x => x === oldName ? saved.tag : x);
          tk.aiTags = (tk.aiTags || []).map(at => at.tag === oldName ? { ...at, tag: saved.tag } : at);
        });
        if (TAG_SELECTED === oldName) setTagSelected(saved.tag);
        TAG_SELECTED_NAMES.delete(oldName);
        Object.assign(t, { tag: saved.tag, type: saved.kind, conf: saved.ai_confidence });
      } else TAG_LIBRARY.unshift({ tag: saved.tag, type: saved.kind, conf: saved.ai_confidence, count: saved.count || 0 });
      if (document.getElementById('tag-name') === input) { closeModal(); renderPage('tags'); }
    } catch (err) { if (status.isConnected) status.textContent = "Couldn't save: " + err.message; }
    finally { saving = false; if (button.isConnected) button.disabled = false; }
  }, t ? 'Save' : 'Create');
  const input = document.getElementById('tag-name');
  const status = document.getElementById('tag-error');
  const button = document.querySelector('#modal-container [data-action="modal.confirm"]');
}

function tagDelete(name) {
  if (!window.isAdmin()) return;
  const t = TAG_LIBRARY.find(x => x.tag === name); if (!t) return;
  const inUse = t.count || 0;
  const workspace = getWorkspaceId(), jwt = getJwt();
  let saving = false;
  showModal('Delete tag', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${window.escHtml(name)}</strong>?${inUse?` It will be removed from <strong style="color:var(--ink)">${inUse} ticket${inUse===1?'':'s'}</strong>.`:''} Any AI suggestions for this tag will also be removed.</div>`, async () => {
    if (saving || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    saving = true;
    try { if (jwt) await apiDelete('/api/v1/tags/' + encodeURIComponent(name)); }
    catch (err) { saving = false; alert("Couldn't delete: " + err.message); return; }
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    TICKETS.forEach(tk => {
      tk.tags = (tk.tags || []).filter(x => x !== name);
      tk.aiTags = (tk.aiTags || []).filter(at => at.tag !== name);
    });
    const i = TAG_LIBRARY.findIndex(x => x.tag === name);
    if (i >= 0) TAG_LIBRARY.splice(i, 1);
    closeModal(); renderPage('tags');
  }, 'Delete');
}

registerActions({
  'tags.history':        () => showTagMergeHistory(),
  'tags.undoMerge':      (ds) => undoTagMerge(ds),
  'tags.openDetail':     (ds) => openTagDetail(ds.tag),
  'tags.closeDetail':    () => closeTagDetail(),
  'tags.setSort':        (ds) => setTagSort(ds.col),
  'tags.bulkDelete':     () => bulkDeleteTags(),
  'tags.clearSelection': () => clearTagSelection(),
  'tags.new':            () => tagNew(),
  'tags.edit':           (ds) => tagEdit(ds.tag),
  'tags.delete':         (ds) => tagDelete(ds.tag),
  'tags.mergePrompt':    (ds) => mergeTagPrompt(ds.tag),
  'tags.openTicket':     (ds) => openTicket(ds.ticketId),
  'tags.openCustomer':   (ds) => { setCustomerSelected(ds.custId); navTo('customers'); },
});

registerChangeActions({
  'tags.toggleSelected': (ds) => toggleTagSelected(ds.tag),
  'tags.toggleAll':      () => toggleAllTags(),
});

registerInputActions({
  'tags.setQuery': (ds, el) => tagSetQuery(el.value),
});

registerMousedownActions({
  // Mousedown-with-close-modal pattern: pick a target in a modal, close
  // it, then dispatch the action. Uses mousedown (not click) so the
  // action fires before core/dismiss.js's mousedown listener sees the
  // outside-click and tries to clean up.
  'tags.mergeFromModal':      (ds) => { closeModal(); mergeTags(ds.source, ds.target); },
});
