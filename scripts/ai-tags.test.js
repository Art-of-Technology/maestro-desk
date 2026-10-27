import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function setup() {
  let timer, calls = [], content = 'withdrawal question', resolve, workspace = 'one';
  const nodes = Object.fromEntries(['[data-applied]', '[data-tag-options]', '[data-suggestions]', '[data-tag-search]', 'details'].map(k => [k, { value: '', innerHTML: '', open: false }]));
  const host = { isConnected: true, querySelector: key => nodes[key] };
  const model = { id: 'ticket', _uuid: 'uuid', tags: [] };
  const ctx = {
    TAG_LIBRARY: ['withdrawal','billing','bonus','account'].map(tag => ({ tag })),
    can: () => true, getJwt: () => 'jwt', getWorkspaceId: () => workspace,
    apiGet: async () => ({ tags: ctx.TAG_LIBRARY }),
    callClaude: input => { calls.push(input); return new Promise(r => { resolve = r; }); },
    document: { getElementById: () => host }, window: { escAttr: String, escHtml: String },
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout() {},
  };
  const source = readFileSync('web/js/tickets/tag-controls.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
  runInNewContext(source + '\nglobalThis.controls={mountTagControls,scheduleTagSuggestions,validSuggestions,availableTags};', ctx);
  ctx.controls.mountTagControls(model, () => content, async tag => model.tags.push(tag), async tag => { model.tags = model.tags.filter(t => t !== tag); });
  return { ctx, model, nodes, calls, host, run: () => timer(), reply: names => resolve({ text: JSON.stringify(names) }), content: text => { content = text; ctx.controls.scheduleTagSuggestions(model); }, switch: () => { workspace = 'two'; } };
}
test('offers library tags only, filters search and caps unique suggestions at three', () => {
  const f = setup();
  expect([...f.ctx.controls.validSuggestions(['fake','bonus','bonus','billing','withdrawal','account'])]).toEqual(['bonus','billing','withdrawal']);
  expect([...f.ctx.controls.validSuggestions(['bonus','billing'], ['bonus'])]).toEqual(['billing']);
  expect(f.ctx.controls.availableTags([], 'BILL').map(t => t.tag)).toEqual(['billing']);
});
test('uses current draft context and does not spend again on unchanged content', async () => {
  const f = setup(); const first = f.run();
  expect(f.calls[0].ticketId).toBe('uuid');
  f.reply(['withdrawal']); await first;
  await f.run(); expect(f.calls).toHaveLength(1);
  f.content('draft about billing'); const next = f.run();
  expect(f.calls[1].messages[0].content).toContain('draft about billing');
  f.reply(['billing']); await next;
  expect(f.model.tagSuggestions.names).toEqual(['billing']);
});
test('discards replies for stale drafts and changed workspaces', async () => {
  const f = setup(); const first = f.run();
  f.content('changed draft'); f.reply(['withdrawal']); await first;
  expect(f.model.tagSuggestions.names).toEqual([]);
  const next = f.run(); f.switch(); f.reply(['billing']); await next;
  expect(f.model.tagSuggestions.names).toEqual([]);
});
test('works before a ticket exists and applies chosen suggestions locally', async () => {
  const f = setup(); delete f.model._uuid;
  const first = f.run(); expect(f.calls[0].ticketId).toBeUndefined();
  f.reply(['bonus']); await first;
  await f.host.onclick({ target: { closest: () => ({ dataset: { tagOperation: 'add', tag: 'bonus' } }) } });
  expect(f.model.tags).toEqual(['bonus']);
  await f.host.onclick({ target: { closest: () => ({ dataset: { tagOperation: 'add', tag: 'invented' } }) } });
  expect(f.model.tags).toEqual(['bonus']);
});
