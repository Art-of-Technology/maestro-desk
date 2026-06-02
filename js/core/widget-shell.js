// ─── Customisable widget shell (dashboard + reports) ───────────────────────
// Each widget on the dashboard or reports page is wrapped with a chrome that
// provides a drag handle, a "..." menu (hide + chart-type switcher where
// available), and an aria-friendly hide button. Layouts (order, hidden set,
// per-widget chart choice) persist in localStorage so each agent's
// customisations stick across reloads.
//
// Click + change handlers route through core/event-delegation.js. Drag
// events (dragstart/end/over/leave/drop) are handled by a module-internal
// document-level dispatcher at the bottom of this file — drag is sparse
// (only this module uses it across the whole codebase), so it lives here
// rather than in the shared harness.
//
// External reaches (interim, via window): escAttr, escHtml, renderPage —
// app.js utilities.
//
// Widget catalogs (the per-page widget definitions + default layout) are
// pushed in by the owning page module at load time via
// registerWidgetCatalog(scope, ...): dashboard registers 'dash', reports
// registers 'report'. This keeps the generic shell from importing the
// per-page catalogs (which would invert the dependency / cycle) and removes
// the old reliance on window.DASH_WIDGETS / window.REPORT_WIDGETS.
//
// DASH_LAYOUT and REPORT_LAYOUT live in core/state.js so this module and
// app.js (top-level hydration + reports renderers) share one binding.

import { showModal, closeModal } from './modal.js';
import { registerActions, registerChangeActions } from './event-delegation.js';

// scope ('dash' | 'report') → { widgets, defaultLayout }
const _CATALOGS = Object.create(null);

export function registerWidgetCatalog(scope, widgets, defaultLayout) {
  _CATALOGS[scope] = { widgets, defaultLayout };
}
function catalogWidgets(scope)       { return _CATALOGS[scope]?.widgets || []; }
function catalogDefaultLayout(scope) { return _CATALOGS[scope]?.defaultLayout; }

export function loadLayout(key, fallback) {
  // Always deep-clone the fallback so any mutation through the returned
  // object can't bleed into DEFAULT_*_LAYOUT (or affect a sibling page using
  // the same fallback).
  const cloneFallback = () => ({
    order:  [...fallback.order],
    hidden: [...fallback.hidden],
    charts: { ...fallback.charts },
  });
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    if (!raw || typeof raw !== 'object') return cloneFallback();
    return {
      order:  Array.isArray(raw.order)  ? raw.order  : [...fallback.order],
      hidden: Array.isArray(raw.hidden) ? raw.hidden : [...fallback.hidden],
      charts: (raw.charts && typeof raw.charts === 'object') ? raw.charts : { ...fallback.charts },
    };
  } catch (e) { return cloneFallback(); }
}
function saveLayout(key, layout) {
  // Quota errors (private mode / disk full) shouldn't crash the page. Log so
  // a developer can see it in console, but let the in-memory layout keep
  // working for the rest of the session.
  try { localStorage.setItem(key, JSON.stringify(layout)); }
  catch (e) { console.warn('[layout] persist failed', key, e); }
}

// New widgets added in code releases need to land at the end of the order so
// they're discoverable without nuking the agent's existing arrangement.
export function reconcileLayout(layout, widgets) {
  const ids = widgets.map(w => w.id);
  layout.order = layout.order.filter(id => ids.includes(id));
  ids.forEach(id => { if (!layout.order.includes(id)) layout.order.push(id); });
  layout.hidden = layout.hidden.filter(id => ids.includes(id));
  return layout;
}

function widgetChrome(scope, w, innerHtml, chartType) {
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
  const chartMenu = (w.charts && w.charts.length > 1) ? `<button title="Chart type" data-action="widget.showChartMenu" data-widget-scope="${sid}" data-widget-id="${wid}">📊</button>` : '';
  return `
    <div class="widget card ${window.escAttr(spanClass)}" data-widget-scope="${sid}" data-widget-id="${wid}" draggable="true">
      <div class="widget-head" title="Drag to reorder">
        <span class="widget-handle">⋮⋮</span>
        <span class="widget-title">${window.escHtml(w.title)}${chartType ? ` · <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink3);font-style:italic">${window.escHtml(chartType)}</span>` : ''}</span>
        <div class="widget-actions">
          ${chartMenu}
          <button title="Hide widget" data-action="widget.hide" data-widget-scope="${sid}" data-widget-id="${wid}">×</button>
        </div>
      </div>
      <div class="widget-body">${body}</div>
    </div>`;
}

export function renderWidgetGrid(scope, gridClass, widgets, layout, stats) {
  const byId = Object.fromEntries(widgets.map(w => [w.id, w]));
  const items = layout.order
    .filter(id => !layout.hidden.includes(id))
    .map(id => byId[id])
    .filter(Boolean);
  const hiddenN = layout.hidden.length;
  const cards = items.map(w => widgetChrome(scope, w, w.render(stats), layout.charts[w.id])).join('');
  return `
    <div class="${gridClass}" data-widget-scope="${scope}">${cards}</div>
    <div style="margin-top:14px;display:flex;justify-content:flex-end">
      <button class="btn btn-sm" data-action="widget.openManage" data-widget-scope="${window.escAttr(scope)}">⚙ Manage widgets${hiddenN ? ` · ${hiddenN} hidden` : ''}</button>
    </div>`;
}

let _widgetDragging = null;
function widgetDragStart(ev, widget) {
  _widgetDragging = { scope: widget.dataset.widgetScope, id: widget.dataset.widgetId };
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
  if (!_widgetDragging || _widgetDragging.scope !== scope) return;
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
  if (!_widgetDragging || _widgetDragging.scope !== scope) return;
  ev.preventDefault();
  const rect = widget.getBoundingClientRect();
  const before = (ev.clientX - rect.left) < rect.width / 2;
  widget.classList.remove('drop-target-before','drop-target-after');
  reorderWidget(scope, _widgetDragging.id, targetId, before);
}

function reorderWidget(scope, srcId, targetId, before) {
  const layout = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  const i = layout.order.indexOf(srcId);
  if (i < 0) return;
  layout.order.splice(i, 1);
  let j = layout.order.indexOf(targetId);
  if (j < 0) j = layout.order.length;
  if (!before) j += 1;
  layout.order.splice(j, 0, srcId);
  saveLayout(scope === 'dash' ? 'dash_layout' : 'report_layout', layout);
  window.renderPage(scope === 'dash' ? 'dashboard' : 'reports');
}

function hideWidgetById(scope, id) {
  const layout = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  if (!layout.hidden.includes(id)) layout.hidden.push(id);
  saveLayout(scope === 'dash' ? 'dash_layout' : 'report_layout', layout);
  window.renderPage(scope === 'dash' ? 'dashboard' : 'reports');
}
function showWidgetById(scope, id) {
  const layout = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  layout.hidden = layout.hidden.filter(x => x !== id);
  saveLayout(scope === 'dash' ? 'dash_layout' : 'report_layout', layout);
  window.renderPage(scope === 'dash' ? 'dashboard' : 'reports');
}
function setWidgetChart(scope, id, chartType) {
  const layout = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  layout.charts = layout.charts || {};
  layout.charts[id] = chartType;
  saveLayout(scope === 'dash' ? 'dash_layout' : 'report_layout', layout);
  document.querySelectorAll('.widget-menu').forEach(el => el.remove());
  window.renderPage(scope === 'dash' ? 'dashboard' : 'reports');
}
function resetWidgetLayout(scope) {
  const isDash = scope === 'dash';
  const src = catalogDefaultLayout(scope);
  if (!src) return;
  const layout = { order: [...src.order], hidden: [...src.hidden], charts: { ...src.charts } };
  if (isDash) DASH_LAYOUT = layout; else REPORT_LAYOUT = layout;
  saveLayout(isDash ? 'dash_layout' : 'report_layout', layout);
  closeModal();
  window.renderPage(isDash ? 'dashboard' : 'reports');
}

function showWidgetMenu(anchor, scope, id, kind) {
  document.querySelectorAll('.widget-menu').forEach(el => el.remove());
  const widgets = catalogWidgets(scope);
  const layout  = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  const w = widgets.find(x => x.id === id);
  if (!w || kind !== 'chart' || !w.charts) return;
  const current = layout.charts[id] || w.charts[0];
  const menu = document.createElement('div');
  menu.className = 'widget-menu';
  menu.innerHTML = `
    <div class="widget-menu-head">Chart type</div>
    ${w.charts.map(c => `<div class="widget-menu-item ${c===current?'active':''}" data-action="widget.setChart" data-widget-scope="${window.escAttr(scope)}" data-widget-id="${window.escAttr(id)}" data-chart="${window.escAttr(c)}">${c === current ? '✓' : '·'} ${window.escHtml(c)}</div>`).join('')}`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, r.right - 160)}px`;
  // Dismiss on outside click
  setTimeout(() => {
    const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    document.addEventListener('mousedown', close);
  }, 0);
}

function showManageWidgetsModal(scope) {
  const widgets = catalogWidgets(scope);
  const layout  = scope === 'dash' ? DASH_LAYOUT : REPORT_LAYOUT;
  const body = widgets.map(w => {
    const visible = !layout.hidden.includes(w.id);
    return `
      <div class="settings-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:var(--ink)">${window.escHtml(w.title)}</div>
          <div style="font-size:11px;color:var(--ink3);margin-top:2px;font-family:'DM Mono',monospace">${window.escHtml(w.id)}</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${visible?'checked':''} data-change-action="widget.toggleVisible" data-widget-scope="${window.escAttr(scope)}" data-widget-id="${window.escAttr(w.id)}">
          <span class="toggle-slider"></span>
        </label>
      </div>`;
  }).join('');
  showModal(scope === 'dash' ? 'Manage dashboard widgets' : 'Manage report widgets', `
    <div style="font-size:12px;color:var(--ink3);margin-bottom:14px;line-height:1.5">Toggle a widget off to remove it from the layout. Drag the widget headers on the page to rearrange. Order and visibility are saved per browser.</div>
    ${body}
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule);text-align:right">
      <button class="btn btn-sm btn-danger" data-action="widget.reset" data-widget-scope="${window.escAttr(scope)}">Reset to default</button>
    </div>
  `, null, null);
}

registerActions({
  'widget.showChartMenu': (ds, el) => showWidgetMenu(el, ds.widgetScope, ds.widgetId, 'chart'),
  'widget.hide':          (ds) => hideWidgetById(ds.widgetScope, ds.widgetId),
  'widget.openManage':    (ds) => showManageWidgetsModal(ds.widgetScope),
  'widget.setChart':      (ds) => setWidgetChart(ds.widgetScope, ds.widgetId, ds.chart),
  'widget.reset':         (ds) => resetWidgetLayout(ds.widgetScope),
});

registerChangeActions({
  'widget.toggleVisible': (ds, el) => {
    if (el.checked) showWidgetById(ds.widgetScope, ds.widgetId);
    else            hideWidgetById(ds.widgetScope, ds.widgetId);
  },
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
