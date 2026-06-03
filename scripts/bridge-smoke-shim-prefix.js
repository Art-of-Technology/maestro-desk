// DOM/runtime shim — concatenated AHEAD of the bundle, evaluated in the same
// script scope. Lets data.js's top-level `let`/`const` declarations become
// script-scope bindings that nested module fns see by bare name (TICKETS,
// CUSTOMERS, …). state.js is now an ES module bundled via the entry's import
// graph, so it is no longer concatenated here.

globalThis.localStorage = {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
};

function _node() {
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [], childNodes: [],
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, insertBefore() {}, replaceChild() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    innerHTML: '', outerHTML: '', textContent: '', value: '',
    focus() {}, blur() {}, click() {}, scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  documentElement: _node(),
  body: _node(),
  head: _node(),
  getElementById: () => _node(),
  querySelector: () => _node(),
  querySelectorAll: () => [],
  createElement: () => _node(),
  createTextNode: (t) => ({ textContent: t }),
  createDocumentFragment: () => _node(),
};
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.prompt = () => null;
globalThis.location = { hash: '', pathname: '/', href: '' };
globalThis.history = { pushState() {}, replaceState() {} };
