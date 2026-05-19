// ─── data-action event dispatcher ────────────────────────────────────────────
// Document-level event listeners that route DOM events on elements carrying
// `data-action="ns.fnName"` (or `data-change-action="..."`) to handlers
// registered by the owning module at module-init time. Replaces inline
// `onclick=`/`onchange=` handlers (which only resolve through window) so
// feature modules don't need a namespace spread on the window bridge.
//
// Four event types are supported today:
//   - click     via `data-action`           and `registerActions({...})`
//   - change    via `data-change-action`    and `registerChangeActions({...})`
//   - mousedown via `data-mousedown-action` and `registerMousedownActions({...})`
//   - input     via `data-input-action`     and `registerInputActions({...})`
//
// mousedown is used for menus/dropdowns where the action should fire before
// the click would, so the surrounding dismiss/blur logic (core/dismiss.js
// also listens on mousedown) sees the menu in the right state.
//
// input fires on every keystroke / programmatic value change inside text
// inputs and textareas. Handlers typically read `el.value` (not the
// dataset) and update module state + trigger a re-render.
//
// Add more (input, keydown, ...) here only when more than one module needs
// them. One-off cases are better served by direct addEventListener after
// the owning module re-renders (see quick-switcher for the pattern).
//
// Handler signature for both event types: `(dataset, element, event)`.
// `dataset` is the element's DOMStringMap — read named args from there
// (`data-ch-id` arrives as `ds.chId`). The dispatchers do not preventDefault
// — handlers should call it themselves if they need to.
//
// Absorber pattern: an element with `data-action=""` (empty string) is
// matched by `closest()` and stops the search there. The dispatcher's
// `ACTIONS[""]` lookup returns undefined, so nothing fires. Use this on
// container cells that should swallow clicks intended for action targets
// further up the tree (e.g. row-click vs. button-in-row click). Same for
// `data-change-action=""`.
//
// Side-effect import at app startup wires both listeners. Action names are
// unique per event type — registering a duplicate throws so silent
// shadowing can't happen.

const CLICK_ACTIONS     = Object.create(null);
const CHANGE_ACTIONS    = Object.create(null);
const MOUSEDOWN_ACTIONS = Object.create(null);
const INPUT_ACTIONS     = Object.create(null);

function registerInto(registry, attrName, map) {
  for (const name of Object.keys(map)) {
    if (registry[name]) throw new Error(`${attrName} collision: ${name}`);
    if (typeof map[name] !== 'function') throw new Error(`${attrName} ${name} is not a function`);
    registry[name] = map[name];
  }
}

export function registerActions(map)           { registerInto(CLICK_ACTIONS,     'data-action',           map); }
export function registerChangeActions(map)     { registerInto(CHANGE_ACTIONS,    'data-change-action',    map); }
export function registerMousedownActions(map)  { registerInto(MOUSEDOWN_ACTIONS, 'data-mousedown-action', map); }
export function registerInputActions(map)      { registerInto(INPUT_ACTIONS,     'data-input-action',     map); }

function dispatch(registry, attr, e) {
  const el = e.target.closest(`[${attr}]`);
  if (!el) return;
  const fn = registry[el.getAttribute(attr)];
  if (!fn) return;
  fn(el.dataset, el, e);
}

document.addEventListener('click',     e => dispatch(CLICK_ACTIONS,     'data-action',           e));
document.addEventListener('change',    e => dispatch(CHANGE_ACTIONS,    'data-change-action',    e));
document.addEventListener('mousedown', e => dispatch(MOUSEDOWN_ACTIONS, 'data-mousedown-action', e));
document.addEventListener('input',     e => dispatch(INPUT_ACTIONS,     'data-input-action',     e));
