import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function setup() {
  const actions = {}, nodes = { 'tag-name': { value: 'renamed' }, 'tag-error': { isConnected: true }, button: { isConnected: true } };
  let body, confirm, payload;
  const ctx = {
    TAG_LIBRARY: [{ tag: 'billing', type: 'manual', conf: null, count: 3 }, { tag: 'bonus', type: 'ai', conf: 17, count: 1 }],
    TICKETS: [{ id: 'APPLIED', tags: ['bonus'], aiTags: [], status: 'open', priority: 'normal' },
      { id: 'SUGGESTION-ONLY', tags: [], aiTags: [{ tag: 'bonus', conf: 90 }], status: 'open', priority: 'normal' }],
    CUSTOMERS: [], TAG_SELECTED: null, TAG_SELECTED_NAMES: new Set(), TAG_QUERY: '', TAG_SORT_COL: 'count', TAG_SORT_DIR: -1,
    STATUS_COLORS: {}, PRIORITY_COLORS: {},
    getJwt: () => 'jwt', getWorkspaceId: () => 'workspace',
    window: { isAdmin: () => true, escAttr: String, escHtml: String },
    document: { getElementById: id => nodes[id], querySelector: () => nodes.button },
    registerActions: a => Object.assign(actions, a), registerChangeActions: a => Object.assign(actions, a), registerInputActions() {}, registerMousedownActions() {},
    showModal: (title, html, fn) => { body = html; confirm = fn; }, closeModal() {}, renderPage() {},
    apiPatch: async (path, input) => { payload = input; return { tag: { tag: input.tag, kind: 'ai', ai_confidence: 17 } }; },
    apiPost: async (path, input) => { payload = input; return { tag: { tag: input.tag, kind: 'manual', ai_confidence: null, count: 0 } }; },
  };
  const source = readFileSync('web/js/tags/index.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
  runInNewContext(source + '\nglobalThis.render = renderTags;', ctx);
  return { ctx, actions, body: () => body, confirm: () => confirm(), payload: () => payload };
}

test('one library shows both legacy types without type or confidence controls', () => {
  const f = setup(), html = f.ctx.render();
  expect(html).toContain('billing'); expect(html).toContain('bonus');
  expect(html).toContain('Applied ticket tags');
  expect(html).not.toContain('Confidence'); expect(html).not.toContain('Manual');
  for (const action of ['tags.convertType', 'tags.bulkSetType', 'tags.setType', 'tags.toggleConfRow']) expect(f.actions[action]).toBeUndefined();
});

test('renaming a legacy AI tag sends only its name and preserves metadata', async () => {
  const f = setup(); f.actions['tags.edit']({ tag: 'bonus' });
  expect(f.body()).toContain('for="tag-name"');
  expect(f.body()).not.toContain('tag-type'); expect(f.body()).not.toContain('tag-conf');
  await f.confirm();
  expect(f.payload()).toEqual({ tag: 'renamed' });
  expect(f.ctx.TAG_LIBRARY[1]).toEqual({ tag: 'renamed', type: 'ai', conf: 17, count: 1 });
  expect(f.ctx.TICKETS[0].tags).toEqual(['renamed']);
  expect(f.ctx.TICKETS[1].aiTags[0].tag).toBe('renamed');
});

test('creating a tag needs only a name', async () => {
  const f = setup(); f.actions['tags.new'](); await f.confirm();
  expect(f.payload()).toEqual({ tag: 'renamed' });
  expect(f.ctx.TAG_LIBRARY[0].tag).toBe('renamed');
});

test('detail breakdown includes applied tags and excludes unaccepted suggestions', () => {
  const f = setup(); f.ctx.TAG_SELECTED = 'bonus';
  const html = f.ctx.render();
  expect(html).toContain('APPLIED'); expect(html).not.toContain('SUGGESTION-ONLY');
  expect(html).not.toContain('Confidence'); expect(html).not.toContain('Convert to');
});

test('demo counts use applied tags instead of seeded confidence/type totals', () => {
  const f = setup(); f.ctx.getJwt = () => null; f.ctx.render();
  expect(f.ctx.TAG_LIBRARY.map(t => t.count)).toEqual([0, 1]);
});
