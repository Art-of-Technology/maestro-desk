import { test, expect, mock } from 'bun:test';

const actions = {};
const stored = new Map();
const host = { firstElementChild: null, _html: '', get innerHTML() { return this._html; }, set innerHTML(value) { this._html = value; this.firstElementChild = value ? {} : null; } };
const style = {};
const spotlight = { style: {} };
const card = { style, focus() { this.focused = true; }, getBoundingClientRect: () => ({ width: 380, height: 190 }) };
const target = { scrollIntoView() {}, getBoundingClientRect: () => ({ left: 220, top: 60, right: 420, bottom: 90, width: 200, height: 30 }) };
let navigated = null;

globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.requestAnimationFrame = fn => fn();
globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
globalThis.document = {
  getElementById: id => id === 'guide-container' ? host : null,
  querySelector: selector => selector.startsWith('[data-guide=') ? target : selector === '.guide-spotlight' ? spotlight : selector === '.guide-card' ? card : null,
  addEventListener() {},
};

mock.module('../web/js/core/state.js', () => ({ CURRENT_PAGE: 'dashboard', SESSION: { userId: 'agent-1' } }));
mock.module('../web/js/core/api-client.js', () => ({ getWorkspaceId: () => 'spacecasino' }));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions: map => Object.assign(actions, map) }));

const { GUIDE_VERSION } = await import('../web/js/guides/config.js');
const { guidePageRendered, initGuides, maybeStartGuides } = await import('../web/js/guides/index.js');

test('first run opens, navigation advances, and finishing records the guide version', () => {
  initGuides(page => { navigated = page; });
  maybeStartGuides();
  expect(host.innerHTML).toContain('DASHBOARD · 1 OF 5');
  expect(card.focused).toBe(true);

  actions['guides.next']();
  expect(navigated).toBe('tickets');
  guidePageRendered('tickets');
  expect(host.innerHTML).toContain('TICKETS · 2 OF 5');

  actions['guides.start']({ step: '4' });
  guidePageRendered('agents');
  actions['guides.next']();
  expect(host.innerHTML).toBe('');
  expect(stored.get('respovia_guides:spacecasino:agent-1')).toBe(String(GUIDE_VERSION));
});
