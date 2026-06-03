// ─── Workflows ───────────────────────────────────────────────────────────────
// Config-section page for "When X, then Y" rules. Each workflow is a single
// trigger + single action plus a run history; the engine that actually fires
// them isn't wired up yet — Run now records a manual entry so admins can
// validate the data shape and history pane.
//
// Click/change/input handlers route through core/event-delegation.js.
// `renderWorkflows` is the only export consumed (app.js router).
//
// External reaches (interim, via window): isAdmin, escAttr — all still in
// app.js. showModal and closeModal are direct ES imports.
//
// WORKFLOWS comes from data.js via the global lexical env; WF_SELECTED,
// WF_FILTER, WF_QUERY, SESSION come from core/state.js the same way.

import { renderPage } from '../core/router.js';
import { registerActions, registerChangeActions, registerInputActions } from '../core/event-delegation.js';
import { apiGet, apiPost, apiPatch, apiDelete } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';

const WF_TRIGGER_PRESETS = [
  'Ticket created',
  'Status changed',
  'Status changed to Resolved',
  'Priority changed',
  'Priority = Urgent',
  'Category = GDPR',
  'Age > 72h',
  'Last updated > 7d',
  'CSAT < 3',
];

const WF_ACTION_PRESETS = [
  'Assign to Senior Agent',
  'Set status = Resolved',
  'Set priority = High',
  'Add tag: urgent',
  'Notify Manager',
  'Notify DPO',
  'Send email to customer',
  'Send satisfaction survey email',
];

export function renderWorkflows() {
  if (WF_SELECTED) return renderWfDetail(WF_SELECTED);
  const admin = window.isAdmin();
  let list = [...WORKFLOWS];
  if (WF_FILTER === 'active')   list = list.filter(w => w.status === 'active');
  if (WF_FILTER === 'inactive') list = list.filter(w => w.status === 'inactive');
  if (WF_QUERY.trim()) {
    const q = WF_QUERY.toLowerCase();
    list = list.filter(w => w.name.toLowerCase().includes(q) || w.trigger.toLowerCase().includes(q) || w.action.toLowerCase().includes(q) || w.id.toLowerCase().includes(q));
  }

  const total      = WORKFLOWS.length;
  const activeN    = WORKFLOWS.filter(w => w.status === 'active').length;
  const inactiveN  = total - activeN;
  const totalRuns  = WORKFLOWS.reduce((a, w) => a + (w.runCount || 0), 0);

  const rows = list.map(w => `
    <tr data-action="wf.open" data-wf-id="${window.escAttr(w.id)}" style="cursor:pointer">
      <td class="bold">${w.id}</td>
      <td style="font-weight:500;color:var(--ink)">${w.name}</td>
      <td style="font-size:12px;color:var(--ink2);max-width:240px">${w.trigger}</td>
      <td style="font-size:12px;color:var(--ink2);max-width:240px">${w.action}</td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">${w.runCount || 0}</td>
      <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3)">${w.lastRun || '—'}</td>
      <td style="text-align:center" data-action="">
        <label class="toggle">
          <input type="checkbox" ${w.status==='active'?'checked':''} ${admin?'':'disabled'} data-change-action="wf.toggle" data-wf-id="${window.escAttr(w.id)}">
          <span class="toggle-slider"></span>
        </label>
      </td>
      ${admin ? `<td style="text-align:right;white-space:nowrap" data-action="">
        <button class="btn btn-sm" data-action="wf.run" data-wf-id="${window.escAttr(w.id)}" title="Simulate a run">Run</button>
        <button class="btn btn-sm" data-action="wf.duplicate" data-wf-id="${window.escAttr(w.id)}" title="Duplicate">Copy</button>
        <button class="btn btn-sm" data-action="wf.edit" data-wf-id="${window.escAttr(w.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="wf.delete" data-wf-id="${window.escAttr(w.id)}">Delete</button>
      </td>` : ''}
    </tr>`).join('');

  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-title">Workflows</div>
        ${admin
          ? `<button class="btn btn-solid btn-sm" data-action="wf.new">+ New Workflow</button>`
          : `<span style="font-size:11px;color:var(--ink3);font-style:italic">Read-only — admin access required to edit</span>`}
      </div>
      <div class="kpi-bar">
        <div class="kpi"><div class="kpi-n">${total}</div><div class="kpi-l">Total</div></div>
        <div class="kpi"><div class="kpi-n c-green">${activeN}</div><div class="kpi-l">Active</div></div>
        <div class="kpi"><div class="kpi-n c-amber">${inactiveN}</div><div class="kpi-l">Inactive</div></div>
        <div class="kpi"><div class="kpi-n c-purple">${totalRuns}</div><div class="kpi-l">Runs (30d)</div></div>
      </div>
      <div class="filter-bar">
        <span class="filter-label">Filter</span>
        <input class="filter-select" id="wf-search" placeholder="Search workflows…" style="width:240px" value="${WF_QUERY}" data-input-action="wf.setQuery"/>
        <select class="filter-select" data-change-action="wf.setFilter">
          <option value="all"      ${WF_FILTER==='all'?'selected':''}>All workflows</option>
          <option value="active"   ${WF_FILTER==='active'?'selected':''}>Active</option>
          <option value="inactive" ${WF_FILTER==='inactive'?'selected':''}>Inactive</option>
        </select>
        ${WF_QUERY?`<span class="filter-tag">"${WF_QUERY}"<span class="rm" data-action="wf.clearQuery">×</span></span>`:''}
        <span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--ink3);margin-left:auto">${list.length} of ${total}</span>
      </div>
      <div style="flex:1;overflow-y:auto">
        <table class="tbl">
          <thead><tr>
            <th>ID</th><th>Name</th><th>Trigger</th><th>Action</th><th>Runs</th><th>Last run</th><th style="text-align:center">Active</th>
            ${admin ? '<th style="text-align:right">Actions</th>' : ''}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${list.length===0 ? `<div class="empty-state"><div class="empty-line"></div><div class="empty-txt">No workflows match the filter</div><div class="empty-line"></div></div>` : ''}
      </div>
    </div>`;
}

function wfSetFilter(v) { WF_FILTER = v; renderPage('workflows'); }

async function wfToggle(id, active) {
  if (!window.isAdmin()) return;
  const w = WORKFLOWS.find(x => x.id === id);
  if (!w) return;
  const next = active ? 'active' : 'inactive';
  if (w._uuid) {
    try { await apiPatch(`/api/v1/workflows/${w._uuid}`, { status: next }); }
    catch (err) { alert(`Couldn't toggle: ${err?.message || err}`); return; }
  }
  w.status = next;
}

async function wfRunNow(id) {
  if (!window.isAdmin()) return;
  const w = WORKFLOWS.find(x => x.id === id);
  if (!w) return;
  if (w._uuid) {
    try { await apiPost(`/api/v1/workflows/${w._uuid}/run`, {}); }
    catch (err) { alert(`Couldn't run: ${err?.message || err}`); return; }
  }
  w.runCount = (w.runCount || 0) + 1;
  w.lastRun = 'just now';
  if (!w.history) w.history = [];
  w.history.unshift({
    ts: new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }),
    triggeredBy: SESSION?.name || 'System',
    type: 'manual',
  });
  if (w.history.length > 50) w.history.length = 50;
  renderPage('workflows');
}

async function duplicateWf(id) {
  if (!window.isAdmin()) return;
  const orig = WORKFLOWS.find(x => x.id === id);
  if (!orig) return;
  if (orig._uuid) {
    let resp;
    try {
      resp = await apiPost('/api/v1/workflows', {
        name:    orig.name + ' (copy)',
        trigger: orig.trigger,
        action:  orig.action,
        status:  'inactive',
      });
    } catch (err) { alert(`Couldn't duplicate: ${err?.message || err}`); return; }
    const w = resp.workflow;
    WORKFLOWS.unshift({
      _uuid:    w.id,
      id:       w.display_id,
      name:     w.name,
      trigger:  unwrap(w.trigger),
      action:   unwrap(w.action),
      status:   w.status,
      runCount: 0,
      lastRun:  null,
      history:  [],
    });
  } else {
    // Demo persona — synthesise an id locally.
    const newId = 'WF-' + String(WORKFLOWS.length + 1).padStart(3, '0');
    WORKFLOWS.unshift({
      id: newId,
      name: orig.name + ' (copy)',
      trigger: orig.trigger,
      action: orig.action,
      status: 'inactive',
      runCount: 0,
      lastRun: null,
      history: [],
    });
  }
  renderPage('workflows');
}

// Mirror of bootstrap.js workflowRuleText so the create/duplicate paths
// here can unwrap a fresh API response without importing bootstrap.
function unwrap(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && typeof val.text === 'string') return val.text;
  return JSON.stringify(val);
}

function openWfDetail(id) {
  WF_SELECTED = id;
  // Fire-and-forget load of the run history for this workflow. The
  // detail renders immediately with whatever's in w.history (usually
  // empty for API-backed workflows on first open); when the fetch
  // resolves, w.history is populated and we re-render if still on it.
  const w = WORKFLOWS.find(x => x.id === id);
  if (w?._uuid && !w._historyLoaded) {
    loadWorkflowRuns(w).then(() => {
      if (WF_SELECTED === id) renderPage('workflows');
    }).catch(err => console.warn('[workflows] runs fetch failed:', err));
  }
  renderPage('workflows');
}

// Fetch + map workflow run history into the SPA's history shape
// ({type, ticketId?, triggeredBy, ts}). Idempotent via _historyLoaded.
async function loadWorkflowRuns(w) {
  if (!w._uuid || w._historyLoaded) return;
  const res = await apiGet(`/api/v1/workflows/${w._uuid}/runs`);
  w.history = (res.runs || []).map((r) => ({
    type:        r.kind,
    ticketId:    r.ticket_display_id || null,
    triggeredBy: r.triggered_by_name || 'System',
    ts:          fmtWfRunTs(r.created_at),
  }));
  w._historyLoaded = true;
}

function fmtWfRunTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function closeWfDetail() {
  // Reset the per-workflow history cache so the next open refetches.
  // Cheap and keeps the view fresh; users mostly only revisit a workflow's
  // history after firing it.
  const w = WORKFLOWS.find(x => x.id === WF_SELECTED);
  if (w) { w._historyLoaded = false; }
  WF_SELECTED = null;
  renderPage('workflows');
}
function wfSetQuery(q) {
  WF_QUERY = q;
  renderPage('workflows');
  const input = document.getElementById('wf-search');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function renderWfDetail(id) {
  const w = WORKFLOWS.find(x => x.id === id);
  if (!w) { WF_SELECTED = null; return renderWorkflows(); }
  const admin = window.isAdmin();
  const history = w.history || [];
  return `
    <div class="page">
      <div class="topbar">
        <div class="tb-breadcrumb">
          <span data-action="wf.close">Workflows</span>
          <span class="tb-sep">/</span>
          <span style="color:var(--ink);font-weight:500">${w.name}</span>
          ${admin ? `<span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-sm" data-action="wf.run" data-wf-id="${window.escAttr(w.id)}">Run now</button>
            <button class="btn btn-sm" data-action="wf.duplicate" data-wf-id="${window.escAttr(w.id)}">Duplicate</button>
            <button class="btn btn-sm" data-action="wf.edit" data-wf-id="${window.escAttr(w.id)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-action="wf.delete" data-wf-id="${window.escAttr(w.id)}">Delete</button>
          </span>` : ''}
        </div>
      </div>
      <div class="page-scroll">
        <div class="card" style="display:flex;gap:18px;align-items:center;padding:20px;margin-bottom:16px">
          <div style="width:54px;height:54px;border-radius:var(--r2);background:linear-gradient(135deg,var(--purple),#22d3ee);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 12h4l3-7 4 14 3-7h4" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:20px;font-weight:700;color:var(--ink);letter-spacing:-.02em">${w.name}</div>
            <div style="font-size:13px;color:var(--ink3);margin-top:6px">${w.id} · ${w.runCount || 0} run${w.runCount===1?'':'s'}${w.lastRun ? ' · last ' + w.lastRun : ''}</div>
          </div>
          ${admin
            ? `<label class="toggle"><input type="checkbox" ${w.status==='active'?'checked':''} data-change-action="wf.toggleAndRender" data-wf-id="${window.escAttr(w.id)}"><span class="toggle-slider"></span></label>`
            : `<span class="tag ${w.status==='active'?'tag-resolved':'tag-pending'}" style="text-transform:capitalize">${w.status}</span>`}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
          <div class="card">
            <div class="card-title">When (trigger)</div>
            <div style="font-size:13px;color:var(--ink);line-height:1.6">${w.trigger}</div>
          </div>
          <div class="card">
            <div class="card-title">Then (action)</div>
            <div style="font-size:13px;color:var(--ink);line-height:1.6">${w.action}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div class="r-tile" style="border-color:rgba(139,92,246,0.3);background:var(--purple-lt)"><div class="r-tile-n" style="color:var(--purple)">${w.runCount || 0}</div><div class="r-tile-l" style="color:var(--purple)">Total runs</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink);font-size:14px;line-height:1.3">${w.lastRun || '—'}</div><div class="r-tile-l" style="color:var(--ink3)">Last run</div></div>
          <div class="r-tile" style="border-color:${w.status==='active'?'rgba(52,211,153,0.3)':'rgba(251,191,36,0.3)'};background:${w.status==='active'?'var(--green-lt)':'var(--amber-lt)'}"><div class="r-tile-n" style="color:${w.status==='active'?'var(--green)':'var(--amber)'};font-size:16px;text-transform:capitalize">${w.status}</div><div class="r-tile-l" style="color:${w.status==='active'?'var(--green)':'var(--amber)'}">Status</div></div>
          <div class="r-tile"><div class="r-tile-n" style="color:var(--ink)">${history.length}</div><div class="r-tile-l" style="color:var(--ink3)">Logged events</div></div>
        </div>

        <div class="card">
          <div class="card-title">Run history</div>
          ${history.length ? `
            <div style="display:flex;flex-direction:column;gap:6px;max-height:520px;overflow-y:auto">
              ${history.slice(0, 50).map(h => `
                <div style="display:flex;gap:10px;align-items:center;padding:8px 12px;border:1px solid var(--rule);border-radius:var(--r);background:var(--off2)">
                  <div style="width:6px;height:6px;border-radius:50%;background:var(--purple);flex-shrink:0"></div>
                  <span style="font-size:12px;color:var(--ink2);flex:1">${h.type === 'manual' ? 'Manual run' : 'Triggered run'}${h.ticketId ? ' on ' + h.ticketId : ''}</span>
                  <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${h.triggeredBy || 'System'}</span>
                  <span style="font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)">${h.ts}</span>
                </div>`).join('')}
            </div>
          ` : `<div style="font-size:12px;color:var(--ink3);text-align:center;padding:24px 0">No runs logged yet — use "Run now" to record a manual fire.</div>`}
        </div>
      </div>
    </div>`;
}

function wfFormBody(w) {
  const esc = s => String(s||'').replace(/"/g,'&quot;');
  return `
    <div class="form-row"><label class="form-label">Name</label><input class="form-input" id="wf-name" value="${esc(w?.name)}" placeholder="e.g. Notify on urgent billing"/></div>
    <div class="form-row"><label class="form-label">Trigger</label>
      <input class="form-input" id="wf-trigger" list="wf-trigger-list" value="${esc(w?.trigger)}" placeholder="When this should run"/>
      <datalist id="wf-trigger-list">${WF_TRIGGER_PRESETS.map(t => `<option value="${t}">`).join('')}</datalist>
    </div>
    <div class="form-row"><label class="form-label">Action</label>
      <input class="form-input" id="wf-action" list="wf-action-list" value="${esc(w?.action)}" placeholder="What should happen"/>
      <datalist id="wf-action-list">${WF_ACTION_PRESETS.map(a => `<option value="${a}">`).join('')}</datalist>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="font-family:'Inter',sans-serif;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)">Active</span>
      <label class="toggle"><input type="checkbox" id="wf-active" ${(!w || w.status==='active')?'checked':''}><span class="toggle-slider"></span></label>
    </div>`;
}

function wfNew() {
  if (!window.isAdmin()) return;
  showModal('New workflow', wfFormBody(null), async () => {
    const name    = document.getElementById('wf-name').value.trim();
    const trigger = document.getElementById('wf-trigger').value.trim();
    const action  = document.getElementById('wf-action').value.trim();
    const active  = document.getElementById('wf-active').checked;
    if (!name || !trigger || !action) return;
    const status = active ? 'active' : 'inactive';
    // If we have ANY API workflow loaded, assume the workspace is API-backed.
    // Demo persona doesn't load API workflows so its WORKFLOWS array is the
    // data.js seed (no _uuid on any row).
    const apiBacked = WORKFLOWS.some((w) => w._uuid);
    if (apiBacked) {
      let resp;
      try { resp = await apiPost('/api/v1/workflows', { name, trigger, action, status }); }
      catch (err) { alert(`Couldn't create: ${err?.message || err}`); return; }
      const w = resp.workflow;
      WORKFLOWS.unshift({
        _uuid:    w.id,
        id:       w.display_id,
        name:     w.name,
        trigger:  unwrap(w.trigger),
        action:   unwrap(w.action),
        status:   w.status,
        runCount: 0,
        lastRun:  null,
      });
    } else {
      const id = 'WF-' + String(WORKFLOWS.length + 1).padStart(3, '0');
      WORKFLOWS.unshift({ id, name, trigger, action, status, runCount:0, lastRun:null });
    }
    closeModal(); renderPage('workflows');
  }, 'Create');
}

function wfEdit(id) {
  if (!window.isAdmin()) return;
  const w = WORKFLOWS.find(x => x.id === id); if (!w) return;
  showModal(`Edit ${w.id}`, wfFormBody(w), async () => {
    const name    = document.getElementById('wf-name').value.trim();
    const trigger = document.getElementById('wf-trigger').value.trim();
    const action  = document.getElementById('wf-action').value.trim();
    const active  = document.getElementById('wf-active').checked;
    if (!name || !trigger || !action) return;
    const status = active ? 'active' : 'inactive';
    if (w._uuid) {
      try { await apiPatch(`/api/v1/workflows/${w._uuid}`, { name, trigger, action, status }); }
      catch (err) { alert(`Couldn't save: ${err?.message || err}`); return; }
    }
    w.name = name; w.trigger = trigger; w.action = action;
    w.status = status;
    closeModal(); renderPage('workflows');
  }, 'Save');
}

function wfDelete(id) {
  if (!window.isAdmin()) return;
  const w = WORKFLOWS.find(x => x.id === id); if (!w) return;
  showModal('Delete workflow', `<div style="font-size:13px;color:var(--ink2);line-height:1.6">Permanently delete <strong style="color:var(--ink)">${w.name}</strong>? This cannot be undone.</div>`, async () => {
    if (w._uuid) {
      try { await apiDelete(`/api/v1/workflows/${w._uuid}`); }
      catch (err) { alert(`Couldn't delete: ${err?.message || err}`); return; }
    }
    const i = WORKFLOWS.findIndex(x => x.id === id);
    if (i >= 0) WORKFLOWS.splice(i, 1);
    closeModal(); renderPage('workflows');
  }, 'Delete');
}

registerActions({
  'wf.open':       (ds) => openWfDetail(ds.wfId),
  'wf.close':      () => closeWfDetail(),
  'wf.new':        () => wfNew(),
  'wf.edit':       (ds) => wfEdit(ds.wfId),
  'wf.delete':     (ds) => wfDelete(ds.wfId),
  'wf.duplicate':  (ds) => duplicateWf(ds.wfId),
  'wf.run':        (ds) => wfRunNow(ds.wfId),
  'wf.clearQuery': () => wfSetQuery(''),
});

registerChangeActions({
  'wf.toggle':          (ds, el) => wfToggle(ds.wfId, el.checked),
  // Detail page also re-renders so workload counts + history update.
  'wf.toggleAndRender': (ds, el) => { wfToggle(ds.wfId, el.checked); renderPage('workflows'); },
  'wf.setFilter':       (ds, el) => wfSetFilter(el.value),
});

registerInputActions({
  'wf.setQuery': (ds, el) => wfSetQuery(el.value),
});
