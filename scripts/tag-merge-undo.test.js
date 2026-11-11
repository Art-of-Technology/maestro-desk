import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function setup() {
  let confirm, workspace = 'one', calls = 0, resolve;
  const status = { isConnected: true, textContent: '' }, button = { isConnected: true, disabled: false };
  const actions = {};
  const ctx = {
    TAG_LIBRARY: [], TAG_SELECTED: null, TICKETS: [{ _uuid: 'ticket', tags: ['target'], aiTags: [{ tag: 'target', conf: 90 }], _detailLoaded: true }],
    getWorkspaceId: () => workspace, getJwt: () => 'jwt',
    window: { isAdmin: () => true, escHtml: String, escAttr: String },
    document: { getElementById: () => status, querySelector: () => button },
    registerActions: a => Object.assign(actions, a), registerChangeActions() {}, registerInputActions() {}, registerMousedownActions() {},
    showModal: (title, body, fn) => { confirm = fn; }, closeModal() {}, renderPage() {},
    apiPost: () => { calls++; return new Promise(r => { resolve = r; }); },
    apiGet: async () => ({ tags: [{ tag: 'source', kind: 'ai', ai_confidence: 72, count: 1 }] }),
  };
  const source = readFileSync('web/js/tags/index.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
  runInNewContext(source + '\nglobalThis.mergeTags = mergeTags;', ctx);
  actions['tags.undoMerge']({ id: 'merge', source: 'source', target: 'target' });
  return { ctx, status, button, actions, confirm: () => confirm(), calls: () => calls, switch: () => { workspace = 'two'; },
    reply: () => resolve({ source: 'source', target: 'target', assignments: [
      { ticket_id: 'ticket', kind: 'manual', had_target: false },
      { ticket_id: 'ticket', kind: 'ai', had_target: true, source_confidence: 72, source_accepted: true },
    ] }) };
}

test('undo prevents double submission and restores local manual/AI assignments', async () => {
  const f = setup(), pending = f.confirm();
  await f.confirm(); expect(f.calls()).toBe(1);
  f.reply(); await pending;
  expect([...f.ctx.TICKETS[0].tags]).toEqual(['source']);
  expect(f.ctx.TICKETS[0].aiTags.map(t => t.tag)).toEqual(['target', 'source']);
  expect(f.ctx.TICKETS[0]._detailLoaded).toBe(false);
  expect(f.ctx.TAG_LIBRARY[0].tag).toBe('source');
});

test('undo ignores responses after switching workspace', async () => {
  const f = setup(), pending = f.confirm();
  f.switch(); f.reply(); await pending;
  expect(f.ctx.TICKETS[0].tags).toEqual(['target']);
  expect(f.ctx.TAG_LIBRARY).toHaveLength(0);
});

test('a refresh failure after successful undo does not offer to undo twice', async () => {
  const f = setup(); f.ctx.apiGet = async () => { throw Error('offline'); };
  const pending = f.confirm(); f.reply(); await pending;
  expect(f.status.textContent).toContain('Merge undone');
  await f.confirm(); expect(f.calls()).toBe(1);
  expect(f.button.disabled).toBe(true);
});

test('conflicts leave the cache intact and show the server explanation', async () => {
  const f = setup(); f.ctx.apiPost = async () => { throw Error('Affected ticket changed'); };
  await f.confirm();
  expect(f.status.textContent).toBe('Affected ticket changed');
  expect(f.ctx.TICKETS[0].tags).toEqual(['target']);
  expect(f.button.disabled).toBe(false);
});

test('merging overlapping AI tags keeps the target metadata and the server usage count', async () => {
  const f = setup();
  f.ctx.TAG_LIBRARY.push({ tag: 'source', count: 2 }, { tag: 'target', count: 1 });
  f.ctx.TICKETS[0].aiTags.push({ tag: 'source', conf: 72 });
  f.ctx.apiPost = async () => ({ target_count: 2 });
  await f.ctx.mergeTags('source', 'target');
  expect(f.ctx.TICKETS[0].aiTags).toEqual([{ tag: 'target', conf: 90 }]);
  expect(f.ctx.TAG_LIBRARY).toEqual([{ tag: 'target', count: 2 }]);
});
