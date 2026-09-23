import { test, expect, mock } from 'bun:test';

const actions = {};
const stored = new Map();
const host = { firstElementChild: null, _html: '', get innerHTML() { return this._html; }, set innerHTML(value) { this._html = value; this.firstElementChild = value ? {} : null; } };
const style = {};
const spotlight = { style: {} };
const firstButton = { focus() { document.activeElement = this; } };
const lastButton = { focus() { document.activeElement = this; } };
const card = { style, focus() { this.focused = true; document.activeElement = this; }, querySelectorAll: () => [firstButton, lastButton], getBoundingClientRect: () => ({ width: 380, height: 190 }) };
const target = { scrollIntoView() {}, getBoundingClientRect: () => ({ left: 220, top: 60, right: 420, bottom: 90, width: 200, height: 30 }) };
let navigated = null;
let keydown = null;
let targetSelector = null;

globalThis.window = globalThis;
globalThis.escHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.requestAnimationFrame = fn => fn();
globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
globalThis.document = {
  getElementById: id => id === 'guide-container' ? host : null,
  querySelector: selector => selector.startsWith('[data-guide=') ? (targetSelector = selector, target) : selector === '.guide-spotlight' ? spotlight : ['.guide-card', '.guide-card, .guide-menu'].includes(selector) ? card : null,
  addEventListener(type, handler) { if (type === 'keydown') keydown = handler; },
};

mock.module('../web/js/core/state.js', () => ({ CURRENT_PAGE: 'dashboard', SESSION: { userId: 'agent-1' } }));
mock.module('../web/js/core/api-client.js', () => ({ getWorkspaceId: () => 'spacecasino' }));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions: map => Object.assign(actions, map) }));

const { GUIDE_STEPS, GUIDE_VERSION } = await import('../web/js/guides/config.js');
const { guidePageRendered, initGuides, maybeStartGuides } = await import('../web/js/guides/index.js');

test('first run opens, navigation advances, and finishing records the guide version', () => {
  initGuides(page => { navigated = page; });
  maybeStartGuides();
  expect(host.innerHTML).toContain(`GETTING STARTED · 1 OF ${GUIDE_STEPS.length}`);
  expect(host.innerHTML).toContain(GUIDE_STEPS[0].instructions[0]);
  expect(card.focused).toBe(true);
  let prevented = false;
  keydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  expect(prevented).toBe(true);
  expect(document.activeElement).toBe(lastButton);

  actions['guides.next']();
  expect(navigated).toBe('tickets');
  guidePageRendered('tickets');
  expect(host.innerHTML).toContain(`GETTING STARTED · 2 OF ${GUIDE_STEPS.length}`);

  for (let i = 2; i < GUIDE_STEPS.length; i++) {
    actions['guides.next']();
    guidePageRendered(GUIDE_STEPS[i].page);
    expect(host.innerHTML).toContain(GUIDE_STEPS[i].title);
    expect(host.innerHTML).toContain(escHtml(GUIDE_STEPS[i].instructions[0]));
    expect(targetSelector).toBe(`[data-guide="${GUIDE_STEPS[i].target || GUIDE_STEPS[i].id}"]`);
  }
  expect(host.innerHTML).toContain('Finish');
  actions['guides.next']();
  expect(host.innerHTML).toBe('');
  expect(stored.get('respovia_guides:spacecasino:agent-1')).toBe(String(GUIDE_VERSION));
});

test('a topic can be revisited directly and exited with Escape', () => {
  actions['guides.open']();
  expect(host.innerHTML).toContain('Use templates and placeholders');
  const index = GUIDE_STEPS.findIndex(step => step.id === 'templates');
  actions['guides.start']({ step: String(index) });
  guidePageRendered('tickets');
  expect(host.innerHTML).toContain('{transaction_reference}');
  keydown({ key: 'Escape' });
  expect(host.innerHTML).toBe('');
});
