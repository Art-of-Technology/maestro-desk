// ─── Customisable widget shell (dashboard + reports) ───────────────────────
// Each widget on the dashboard or reports page is wrapped with a chrome that
// provides a drag handle and a hide button. Order and visibility persist
// per account and workspace. Per-user statistic formats are handled by stat-view.js.
//
// Click + change handlers route through core/event-delegation.js. Drag
// events (dragstart/end/over/leave/drop) are handled by a module-internal
// document-level dispatcher at the bottom of this file — drag is sparse
// (only this module uses it across the whole codebase), so it lives here
// rather than in the shared harness.
//
// External reaches (interim, via window): escAttr, escHtml —
// app.js utilities.
//
// Widget catalogs (the per-page widget definitions + default layout) are
// pushed in by the owning page module at load time via
// registerWidgetCatalog(scope, ...): dashboard registers 'dash', reports
// registers 'report'. This keeps the generic shell from importing the
// per-page catalogs (which would invert the dependency / cycle) and removes
// the old reliance on window.DASH_WIDGETS / window.REPORT_WIDGETS.

import { CURRENT_PAGE } from './state.js';
import { getWidgetLayout, saveWidgetLayout, browserWidgetLayout, retryWidgetLayout } from './widget-layout-preferences.js';
import { renderPage } from './router.js';
import { showModal, closeModal } from './modal.js';
import { registerActions, registerChangeActions } from './event-delegation.js';

// scope ('dash' | 'report') → { widgets, defaultLayout }
const _CATALOGS = Object.create(null);

export function registerWidgetCatalog(scope, widgets, defaultLayout) {
  _CATALOGS[scope] = { widgets, defaultLayout };
}
function catalogWidgets(scope)       { return _CATALOGS[scope]?.widgets || []; }
function catalogDefaultLayout(scope) { return _CATALOGS[scope]?.defaultLayout; }
function layoutState(scope) { return _CATALOGS[scope] ? getWidgetLayout(scope, catalogDefaultLayout(scope)) : null; }
const pageFor = scope => scope === 'dash' ? 'dashboard' : 'reports';
function rerender(scope) { if (CURRENT_PAGE === pageFor(scope)) renderPage(CURRENT_PAGE); }
function editable(ds) {
  const state = layoutState(ds.widgetScope);
  return state?.stamp === ds.layoutOwner ? state : null;
}
function statusHtml(state) {
  return window.escHtml(state.status) + (state.failed && !state.busy && !state.loading
    ? ` <button class="btn btn-sm" data-action="widget.retry" data-widget-scope="${state.scope}" data-layout-owner="${state.stamp}">Retry</button>` : '');
}
function statusRegion(state) {
  return `<p class="widget-layout-status report-note" role="status" data-layout-status="${state.scope}" data-layout-owner="${state.stamp}">${statusHtml(state)}</p>`;
}

function widgetChrome(scope, w, innerHtml, owner) {
  // Strip the outer .card wrapper from each widget's existing render so we
  // can put our chrome around it. Widget render functions historically wrap
  // their body in `<div class="card ...">...</div>`; we extract the inner
  // content so the chrome can include a drag handle + menu.
  const m = innerHtml.match(/^\s*<div class="card([^"]*)"([^>]*)>([\s\S]*)<\/div>\s*$/);
  let spanClass = '';
  let body = innerHtml;
  if (m) {
    spanClass = (m[1] || '').trim();
    body = m[3];
    // Strip the widget's own "card-title" so the chrome shows the title.
    body = body.replace(/^\s*<div class="card-title"[^>]*>[\s\S]*?<\/div>\s*/, '');
  } else if (w.span) {
    spanClass = w.span;
  }
  // scope and widget id ride on data-* attributes; escAttr neutralises any
  // quotes to keep the attribute string well-formed.
  const sid = window.escAttr(scope);
  const wid = window.escAttr(w.id);
  return `
    <div class="widget card ${window.escAttr(spanClass)}" data-widget-scope="${sid}" data-widget-id="${wid}" data-layout-owner="${owner}" draggable="true">
      <div class="widget-head" title="Drag to reorder">
        <span class="widget-handle">⋮⋮</span>
        <span class="widget-title">${window.escHtml(w.title)}</span>
        <div class="widget-actions">
          <button title="Hide widget" aria-label="Hide ${window.escAttr(w.title)}" data-action="widget.hide" data-widget-scope="${sid}" data-widget-id="${wid}" data-layout-owner="${owner}">×</button>
        </div>
      </div>
      <div class="widget-body">${body}</div>
    </div>`;
}

export function renderWidgetGrid(scope, gridClass, widgets, stats) {
  const state = layoutState(scope), layout = state.layout;
  const byId = Object.fromEntries(widgets.map(w => [w.id, w]));
  const items = layout.order
    .filter(id => !layout.hidden.includes(id))
    .map(id => byId[id])
    .filter(Boolean);
  const hiddenN = layout.hidden.length;
  const cards = items.map(w => widgetChrome(scope, w, w.render(stats), state.stamp)).join('');
  return `
    <div class="${gridClass}" data-widget-scope="${scope}">${cards}</div>
    ${statusRegion(state)}<div style="margin-top:14px;display:flex;justify-content:flex-end">
      <button class="btn btn-sm" data-action="widget.openManage" data-widget-scope="${window.escAttr(scope)}" data-layout-owner="${state.stamp}">⚙ Manage widgets${hiddenN ? ` · ${hiddenN} hidden` : ''}</button>
    </div>`;
}

let _widgetDragging = null;
function widgetDragStart(ev, widget) {
  if (!editable(widget.dataset)) return;
  _widgetDragging = { scope: widget.dataset.widgetScope, id: widget.dataset.widgetId, owner: widget.dataset.layoutOwner };
  widget.classList.add('dragging');
  ev.dataTransfer.effectAllowed = 'move';
  // Some browsers require setData() to actually start a drag.
  try { ev.dataTransfer.setData('text/plain', _widgetDragging.id); } catch(e) {}
}
function widgetDragEnd(_ev, widget) {
  widget.classList.remove('dragging');
  document.querySelectorAll('.widget.drop-target-before,.widget.drop-target-after').forEach(el => {
    el.classList.remove('drop-target-before','drop-target-after');
  });
  _widgetDragging = null;
}
function widgetDragOver(ev, widget) {
  const scope = widget.dataset.widgetScope;
  const id    = widget.dataset.widgetId;
  if (!_widgetDragging || _widgetDragging.scope !== scope || !editable(widget.dataset) || _widgetDragging.owner !== widget.dataset.layoutOwner) return;
  if (_widgetDragging.id === id) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const rect = widget.getBoundingClientRect();
  const before = (ev.clientX - rect.left) < rect.width / 2;
  widget.classList.toggle('drop-target-before', before);
  widget.classList.toggle('drop-target-after', !before);
}
function widgetDragLeave(_ev, widget) {
  widget.classList.remove('drop-target-before','drop-target-after');
}
function widgetDragDrop(ev, widget) {
  const scope    = widget.dataset.widgetScope;
  const targetId = widget.dataset.widgetId;
  if (!_widgetDragging || _widgetDragging.scope !== scope || !editable(widget.dataset) || _widgetDragging.owner !== widget.dataset.layoutOwner) return;
  ev.preventDefault();
  const rect = widget.getBoundingClientRect();
  const before = (ev.clientX - rect.left) < rect.width / 2;
  widget.classList.remove('drop-target-before','drop-target-after');
  reorderWidget(scope, _widgetDragging.id, targetId, before);
}

function reorderWidget(scope, srcId, targetId, before) {
  const state = layoutState(scope), layout = structuredClone(state.layout);
  if (srcId === targetId) return;
  if (!layout.order.includes(targetId)) return;
  const i = layout.order.indexOf(srcId);
  if (i < 0) return;
  layout.order.splice(i, 1);
  let j = layout.order.indexOf(targetId);
  if (j < 0) j = layout.order.length;
  if (!before) j += 1;
  layout.order.splice(j, 0, srcId);
  saveWidgetLayout(state, layout);
  rerender(scope);
}

function hideWidgetById(state, id) {
  if (!catalogWidgets(state.scope).some(w => w.id === id)) return;
  const layout = structuredClone(state.layout);
  if (!layout.hidden.includes(id)) layout.hidden.push(id);
  saveWidgetLayout(state, layout);
  rerender(state.scope);
}
function showWidgetById(state, id) {
  if (!catalogWidgets(state.scope).some(w => w.id === id)) return;
  const layout = structuredClone(state.layout);
  layout.hidden = layout.hidden.filter(x => x !== id);
  saveWidgetLayout(state, layout);
  rerender(state.scope);
}
function resetWidgetLayout(state) {
  saveWidgetLayout(state, catalogDefaultLayout(state.scope));
  closeModal();
  rerender(state.scope);
}

function showManageWidgetsModal(scope) {
  const widgets = catalogWidgets(scope);
  const state = layoutState(scope), layout = state.layout;
  const body = widgets.map(w => {
    const visible = !layout.hidden.includes(w.id);
    return `
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">${window.escHtml(w.title)}</div>
        </div>
        <label class="toggle">
          <input type="checkbox" aria-label="Show ${window.escAttr(w.title)}" ${visible?'checked':''} data-change-action="widget.toggleVisible" data-widget-scope="${window.escAttr(scope)}" data-widget-id="${window.escAttr(w.id)}" data-layout-owner="${state.stamp}">
          <span class="toggle-slider"></span>
        </label>
      </div>`;
  }).join('');
  showModal(scope === 'dash' ? 'Manage dashboard widgets' : 'Manage Insights widgets', `<div class="widget-manager">
    <p class="report-note">Toggle widgets to show or hide them. Drag widget headers on the page to rearrange. ${state.connected ? 'Order and visibility sync for your account and workspace. Wait for Layout synced before switching devices.' : 'Demo layouts are saved in this browser.'}</p>
    ${statusRegion(state)}
    ${body}
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule);text-align:right">
      ${browserWidgetLayout(scope, state.fallback) ? `<p class="report-note">An old layout is saved in this browser without an account owner. Import it only if it is yours; it will replace this page’s current layout.</p><button class="btn btn-sm" data-action="widget.import" data-widget-scope="${scope}" data-layout-owner="${state.stamp}">Import browser layout</button>` : ''}
      <button class="btn btn-sm btn-danger" data-action="widget.reset" data-widget-scope="${window.escAttr(scope)}" data-layout-owner="${state.stamp}">Reset layout</button>
    </div></div>
  `, null, null);
}

registerActions({
  'widget.hide': ds => { const state = editable(ds); if (state) hideWidgetById(state, ds.widgetId); },
  'widget.openManage': ds => { if (editable(ds)) showManageWidgetsModal(ds.widgetScope); },
  'widget.reset': ds => { const state = editable(ds); if (state) resetWidgetLayout(state); },
  'widget.retry': ds => { const state = editable(ds); if (state) retryWidgetLayout(state); },
  'widget.import': ds => {
    const state = editable(ds);
    if (!state) return;
    const layout = browserWidgetLayout(state.scope, state.fallback);
    if (layout) { saveWidgetLayout(state, layout); closeModal(); rerender(state.scope); }
  },
});

registerChangeActions({
  'widget.toggleVisible': (ds, el) => {
    const state = editable(ds);
    if (!state) return;
    if (el.checked) showWidgetById(state, ds.widgetId);
    else            hideWidgetById(state, ds.widgetId);
  },
});

window.addEventListener?.('respovia:widget-layout', event => {
  const state = layoutState(event.detail.scope);
  if (!state || state.stamp !== event.detail.stamp) return;
  if (event.detail.changed) rerender(state.scope);
  for (const node of document.querySelectorAll('[data-layout-status]')) {
    if (node.dataset.layoutOwner === state.stamp) node.innerHTML = statusHtml(state);
  }
  for (const el of document.querySelectorAll('[data-change-action="widget.toggleVisible"]')) {
    if (el.dataset.layoutOwner === state.stamp) el.checked = !state.layout.hidden.includes(el.dataset.widgetId);
  }
});

// ─── Drag-and-drop dispatcher ────────────────────────────────────────────────
// Drag events fire on the widget element (it carries draggable="true"). We
// delegate from the document so the widget HTML stays declarative —
// closest('.widget[draggable="true"]') resolves which widget the event is
// for; its data-widget-scope/data-widget-id attrs carry the routing keys.
// Module-internal (not in core/event-delegation.js) because drag is only
// used here.
function _dragTarget(e) { return e.target.closest('.widget[draggable="true"]'); }
document.addEventListener('dragstart', e => { const w = _dragTarget(e); if (w) widgetDragStart(e, w); });
document.addEventListener('dragend',   e => { const w = _dragTarget(e); if (w) widgetDragEnd(e, w); });
document.addEventListener('dragover',  e => { const w = _dragTarget(e); if (w) widgetDragOver(e, w); });
document.addEventListener('dragleave', e => { const w = _dragTarget(e); if (w) widgetDragLeave(e, w); });
document.addEventListener('drop',      e => { const w = _dragTarget(e); if (w) widgetDragDrop(e, w); });
