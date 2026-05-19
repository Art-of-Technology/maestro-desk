// ─── data-action click dispatcher ────────────────────────────────────────────
// One document-level click listener routes events on elements that carry a
// `data-action="namespace.fnName"` attribute to a handler the owning module
// registered at module-init time. Replaces inline `onclick="..."` handlers
// (which only resolve through window) so feature modules don't need a
// namespace spread on the window bridge for click handlers.
//
// Handler signature: `(dataset, element, event) => void`. `dataset` is the
// element's DOMStringMap — read named args from there (e.g. data-faq-idx
// arrives as ds.faqIdx). The dispatcher does not preventDefault — handlers
// should call it themselves if they need to.
//
// Side-effect import at app startup wires the listener. Use `registerActions`
// from a module's top level to register handlers. Action names are unique
// across the app — registering a duplicate throws so silent shadowing can't
// happen.

const ACTIONS = Object.create(null);

export function registerActions(map) {
  for (const name of Object.keys(map)) {
    if (ACTIONS[name]) throw new Error(`data-action collision: ${name}`);
    if (typeof map[name] !== 'function') throw new Error(`data-action ${name} is not a function`);
    ACTIONS[name] = map[name];
  }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  fn(el.dataset, el, e);
});
