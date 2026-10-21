import { beforeEach, expect, mock, test } from 'bun:test';

const session = { userId: 'agent-a', role: 'Agent', name: 'Agent A' };
const templates = [{ _uuid: 'one', id: 'TPL-1', name: 'One' }, { _uuid: 'two', id: 'TPL-2', name: 'Two' }];
let workspace = 'workspace-a', jwt, failRead, failWrite, readWait, writeWait, calls, notices;
mock.module('../web/js/core/state.js', () => ({ SESSION: session }));
mock.module('../web/js/core/data.js', () => ({ CANNED_RESPONSES: templates }));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions() {} }));
mock.module('../web/js/core/api-client.js', () => ({
  getWorkspaceId: () => workspace, getJwt: () => jwt,
  async apiGet() {
    if (readWait) return readWait;
    if (failRead) throw Error('Offline');
    return { favourites: ['one'] };
  },
  async apiPatch(path, body) {
    calls.push({ path, body });
    if (writeWait) await writeWait;
    if (failWrite) throw Error('Offline');
    return { template_id: path.split('/').at(-1), pinned: body.pinned };
  },
}));
globalThis.window = { dispatchEvent: () => notices++, escHtml: String, escAttr: String };
const { templateFavourites, loadTemplateFavourites, toggleTemplateFavourite, favouritesRow } = await import('../web/js/tickets/template-favourites.js');

beforeEach(() => {
  session.userId = 'agent-a'; workspace = 'workspace-a'; jwt = crypto.randomUUID();
  failRead = failWrite = false; readWait = writeWait = null; calls = []; notices = 0;
});

test('favourites load from the server; pin and unpin update only after successful persistence', async () => {
  await loadTemplateFavourites();
  expect([...templateFavourites().pins]).toEqual(['one']);
  await toggleTemplateFavourite('two');
  expect(calls).toEqual([{ path: '/api/v1/me/template-favourites/two', body: { pinned: true } }]);
  expect([...templateFavourites().pins]).toEqual(['one', 'two']);
  await toggleTemplateFavourite('one');
  expect([...templateFavourites().pins]).toEqual(['two']);
  expect(calls.at(-1).body).toEqual({ pinned: false });
});

test('load failures are visible, block writes and can be retried', async () => {
  failRead = true; await loadTemplateFavourites();
  expect(templateFavourites().loadError).toBe(true);
  expect(templateFavourites().error).toContain('load');
  await toggleTemplateFavourite('two'); expect(calls).toHaveLength(0);
  failRead = false; await loadTemplateFavourites();
  expect(templateFavourites().loaded).toBe(true);
  expect(templateFavourites().error).toBe('');
});

test('failed writes retain the saved choice and a subsequent click can retry', async () => {
  await loadTemplateFavourites(); failWrite = true;
  await toggleTemplateFavourite('one');
  expect(templateFavourites().pins.has('one')).toBe(true);
  expect(templateFavourites().pending.size).toBe(0);
  expect(templateFavourites().error).toContain('save');
  failWrite = false; await toggleTemplateFavourite('one');
  expect(templateFavourites().pins.has('one')).toBe(false);
});

test('duplicate writes are blocked while other templates can save independently', async () => {
  await loadTemplateFavourites();
  let release; writeWait = new Promise(resolve => { release = resolve; });
  const first = toggleTemplateFavourite('two');
  await toggleTemplateFavourite('two');
  const second = toggleTemplateFavourite('one');
  expect(calls).toHaveLength(2);
  expect(templateFavourites().pins.has('two')).toBe(false);
  release(); await Promise.all([first, second]);
  expect([...templateFavourites().pins]).toEqual(['two']);
});

test('late reads cannot populate another account or workspace', async () => {
  let release; readWait = new Promise(resolve => { release = resolve; });
  const pending = loadTemplateFavourites();
  workspace = 'workspace-b'; session.userId = 'agent-b';
  const next = templateFavourites();
  release({ favourites: ['two'] }); await pending;
  expect([...next.pins]).toEqual([]); expect(notices).toBe(0);
});

test('late writes cannot change a new scope; deleted templates are absent from quick access', async () => {
  await loadTemplateFavourites();
  let release; writeWait = new Promise(resolve => { release = resolve; });
  const pending = toggleTemplateFavourite('two');
  jwt = 'new-session'; const next = templateFavourites();
  release(); await pending;
  expect([...next.pins]).toEqual([]);
  readWait = null; await loadTemplateFavourites();
  templateFavourites().pins.add('deleted');
  expect(favouritesRow('ticket')).not.toContain('data-template-key="deleted"');
  await toggleTemplateFavourite('deleted'); expect(calls).toHaveLength(1);
});

test('demo favourites stay in memory and never write to the API', async () => {
  session.userId = null; jwt = null;
  await toggleTemplateFavourite('two');
  expect(templateFavourites().pins.has('two')).toBe(true); expect(calls).toHaveLength(0);
  session.name = 'Another demo';
  expect(templateFavourites().pins.size).toBe(0);
});
