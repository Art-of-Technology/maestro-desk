import { beforeEach, expect, mock, test } from 'bun:test';
const actions = {}, changes = {}, drag = {}, stored = new Map();
let modal = '', renders = 0, workspace = 'a';
globalThis.localStorage = { getItem: k => stored.get(k) ?? null, setItem: (k,v) => stored.set(k,v) };
globalThis.sessionStorage = { getItem: key => key === 'maestro_workspace_id' ? workspace : null };
globalThis.window = { escHtml: String, escAttr: String, dispatchEvent() {} };
globalThis.document = { addEventListener: (name, fn) => { drag[name] = fn; }, querySelectorAll: () => [] };
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions: map => Object.assign(actions,map), registerChangeActions: map => Object.assign(changes,map) }));
mock.module('../web/js/core/router.js', () => ({ renderPage: () => { renders++; } }));
mock.module('../web/js/core/modal.js', () => ({ showModal: (_title, body) => { modal = body; }, closeModal: () => { modal = ''; } }));
const { setSession, setCurrentPage } = await import('../web/js/core/state.js');
const prefs = await import('../web/js/core/widget-layout-preferences.js');
const shell = await import('../web/js/core/widget-shell.js');
const fallback = { order: ['status','priority','volume'], hidden: [] };
const widgets = fallback.order.map(id => ({ id, title: id, render: () => '<div class="card">content</div>' }));
shell.registerWidgetCatalog('dash', widgets, fallback);
shell.registerWidgetCatalog('report', widgets, fallback);
const state = () => prefs.getWidgetLayout('dash', fallback);
const ds = id => ({ widgetScope: 'dash', widgetId: id, layoutOwner: state().stamp });
beforeEach(() => { stored.clear(); modal = ''; renders = 0; workspace = 'a'; setSession({name:'Demo',role:'Admin'}); setCurrentPage('dashboard'); });

test('hide/show and reset save a page snapshot; hiding everything keeps management reachable', () => {
  for (const id of fallback.order) actions['widget.hide'](ds(id));
  const html = shell.renderWidgetGrid('dash','grid',widgets,{});
  expect(html).toContain('Manage widgets · 3 hidden');
  expect(html).not.toContain('draggable="true"');
  actions['widget.openManage'](ds());
  expect(modal).toContain('aria-label="Show status"');
  changes['widget.toggleVisible'](ds('status'), {checked:true});
  expect(state().layout.hidden).toEqual(['priority','volume']);
  actions['widget.reset'](ds());
  expect(state().layout).toEqual(fallback);
  expect(modal).toBe('');
});
test('old browser layout is offered in the manager and imported only by its action', () => {
  stored.set('dash_layout',JSON.stringify({order:['volume','status','priority'],hidden:['status']}));
  actions['widget.openManage'](ds());
  expect(modal).toContain('Import browser layout');
  expect(state().layout).toEqual(fallback);
  actions['widget.import'](ds());
  expect(state().layout.order[0]).toBe('volume');
  expect(state().layout.hidden).toEqual(['status']);
});
function widget(id, owner = ds(id)) {
  return { dataset: owner, classList: { add(){},remove(){},toggle(){} }, getBoundingClientRect: () => ({left:0,width:100}) };
}
function event(target) { return {target:{closest:()=>target},clientX:1,preventDefault(){},dataTransfer:{setData(){}}}; }
test('drag reorders and persists; stale drags and manager controls cannot edit the next workspace', () => {
  const source = widget('volume'), target = widget('status');
  drag.dragstart(event(source)); drag.drop(event(target));
  expect(state().layout.order).toEqual(['volume','status','priority']);
  drag.dragstart(event(source));
  workspace = 'b';
  const next = state();
  drag.drop(event(widget('priority')));
  actions['widget.hide'](source.dataset); actions['widget.reset'](source.dataset); actions['widget.import'](source.dataset);
  expect(next.layout).toEqual(fallback);
});
test('same-widget drops are no-ops and rendering never mutates either catalog', () => {
  const first = widget('status');
  drag.dragstart(event(first)); drag.drop(event(first));
  expect(renders).toBe(0);
  shell.renderWidgetGrid('dash','grid',widgets,{});
  expect(fallback).toEqual({order:['status','priority','volume'],hidden:[]});
});
