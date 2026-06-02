// Imports every module spread into the window bridge and reports any export
// name that appears in more than one module. Run with `bun scripts/bridge-collision-check.mjs`.

const modules = [
  ['KBIntegration',          '../js/kb-integration/index.js'],
  ['Keybindings',            '../js/core/keybindings.js'],
  ['CustomerModals',         '../js/customers/modals.js'],
];

// state.js + data.js are classic scripts that reference `document`/`localStorage`
// at top level; stub the bits each module's module-init code touches so we can
// import without a DOM. (Imports are evaluated once each.)
globalThis.localStorage = {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
  body: { classList: { add() {}, remove() {} } },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() {
    return {
      style: {}, classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {}, addEventListener() {}, setAttribute() {},
    };
  },
};
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// state.js and data.js are loaded as classic <script> in index.html. Run them
// first so any module that references e.g. `TICKETS` at top level (none of
// these should — module init shouldn't touch shared state — but just in case)
// finds the globals.
await import('../js/core/state.js');
await import('../js/core/data.js');

const exportsByName = new Map(); // name -> [modules that export it]

for (const [alias, path] of modules) {
  let ns;
  try {
    ns = await import(path);
  } catch (e) {
    console.error(`FAILED to import ${alias} (${path}): ${e.message}`);
    continue;
  }
  for (const key of Object.keys(ns)) {
    if (key === 'default') continue;
    if (!exportsByName.has(key)) exportsByName.set(key, []);
    exportsByName.get(key).push(alias);
  }
}

const collisions = [...exportsByName.entries()].filter(([, mods]) => mods.length > 1);

if (collisions.length === 0) {
  console.log(`OK — no name collisions across ${modules.length} module namespaces.`);
} else {
  console.log(`FOUND ${collisions.length} colliding export name(s):\n`);
  for (const [name, mods] of collisions) {
    console.log(`  ${name}  ←  ${mods.join(', ')}`);
  }
  process.exit(1);
}
