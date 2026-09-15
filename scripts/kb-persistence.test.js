// Run separately: module mocks must not affect the API suite or render smokes.
import { test, expect, mock } from 'bun:test';
const articles = [],
  actions = {}, inputs = {};
let jwt = 'session',
  workspace = 'brand-a',
  confirm,
  posts = 0,
  fail = false,
  release;
let postBody, patchCalls = [], patchFail = false, patchRelease, modalLabel;
globalThis.localStorage = { getItem: () => null };
globalThis.window = { isAdmin: () => true, escHtml: String, escAttr: String };
globalThis.alert = () => {};
globalThis.document = {
  getElementById: (id) => ({
    value: {
      'kb-title': 'Withdrawal policy',
      'kb-cat': 'Withdrawals',
      'kb-body': 'Allow 24 hours after approval.',
    }[id],
  }),
};
mock.module('../web/js/core/data.js', () => ({ KB_ARTICLES: articles }));
mock.module('../web/js/core/state.js', () => ({
  CURRENT_PAGE: 'kb',
  KB_SELECTED: null,
  SESSION: { name: 'Test' },
  setKbSelected() {},
}));
mock.module('../web/js/core/router.js', () => ({ renderPage() {} }));
mock.module('../web/js/ai/page.js', () => ({ renderMarkdown: String }));
mock.module('../web/js/core/event-delegation.js', () => ({
  registerActions: (a) => Object.assign(actions, a),
  registerInputActions: a => Object.assign(inputs, a),
}));
mock.module('../web/js/core/presence.js', () => ({ startPresence() {} }));
mock.module('../web/js/core/modal.js', () => ({
  showModal: (_t, _b, cb, label) => {
    confirm = cb;
    modalLabel = label;
  },
  closeModal() {},
}));
mock.module('../web/js/kb/sources.js', () => ({}));
mock.module('../web/js/core/api-client.js', () => ({
  getJwt: () => jwt,
  getWorkspaceId: () => workspace,
  async apiPatch(path, body) {
    patchCalls.push({ path, body });
    if (patchFail) throw new Error('Offline');
    if (patchRelease) await new Promise(resolve => { patchRelease = resolve; });
    return { article: { status: 'published', updated_at: '2026-09-15T12:00:00Z' } };
  },
  apiDelete() {},
  apiPost: async (_path, body) => {
    postBody = body;
    posts++;
    if (fail) throw new Error('Offline');
    if (release)
      await new Promise((resolve) => {
        release = resolve;
      });
    return {
      article: {
        id: 'server-id',
        display_id: 'KB-server',
        title: 'Withdrawal policy',
        body: 'Allow 24 hours after approval.',
        status: body.status,
      },
    };
  },
}));
const { renderKB } = await import('../web/js/kb/index.js');
test('first live article persists, failures do not fake success, and late responses stay in their workspace', async () => {
  actions['kb.new']();
  expect(modalLabel).toBe('Save draft');
  await confirm();
  expect(postBody.status).toBe('draft');
  expect(articles[0].status).toBe('draft');
  expect(posts).toBe(1);
  expect(articles[0]._uuid).toBe('server-id');
  articles.length = 0;
  fail = true;
  actions['kb.new']();
  await confirm();
  expect(articles).toHaveLength(0);
  fail = false;
  await confirm();
  expect(articles).toHaveLength(1);
  articles.length = 0;
  release = true;
  actions['kb.new']();
  const saving = confirm();
  const before = posts;
  await confirm();
  expect(posts).toBe(before);
  workspace = 'brand-b';
  release();
  await saving;
  expect(articles).toHaveLength(0);
  release = null;
  jwt = null;
  workspace = null;
  actions['kb.new']();
  await confirm();
  expect(posts).toBe(before);
  expect(articles[0].id).toBe('KB-001');
});

test('bulk UI selects only matching drafts, clears filters, guards confirmation and retries failures', async () => {
  const originalGetElementById = document.getElementById;
  const originalQuerySelector = document.querySelector;
  const originalIsAdmin = window.isAdmin;
  try {
    jwt = 'session'; workspace = 'brand-a'; patchCalls = []; patchRelease = null; patchFail = false;
    const progress = { isConnected: true, textContent: '' };
    document.getElementById = () => progress;
    document.querySelector = () => null;
    articles.splice(0, articles.length,
      { id: 'KB-a', _uuid: 'a', title: 'A', body: 'Link', category: 'Games · en-ca', status: 'draft' },
      { id: 'KB-b', _uuid: 'b', title: 'B', body: 'Link', category: 'Website · en-ca', status: 'draft' },
      { id: 'KB-c', _uuid: 'c', title: 'C', body: 'Link', category: 'Games · pt-br', status: 'draft' },
      { id: 'KB-d', _uuid: 'd', title: 'D', body: 'Link', category: 'Games · en-ca', status: 'published' });
    actions['kb.setStatus']({ status: 'all' });
    renderKB();
    actions['kb.selectMatching']();
    expect(renderKB()).toContain('3 selected');
    actions['kb.setCat']({ cat: 'Games · en-ca' });
    expect(renderKB()).toContain('0 selected');
    actions['kb.selectMatching']();
    actions['kb.publishSelected']();
    expect(modalLabel).toBe('Publish 1 article');
    workspace = 'other';
    await confirm();
    expect(patchCalls).toHaveLength(0);
    workspace = 'brand-a';
    actions['kb.publishSelected']();
    const button = { disabled: false, textContent: '' };
    document.querySelector = () => { throw new Error('Unexpected DOM failure'); };
    await confirm();
    expect(patchCalls).toHaveLength(0);
    document.querySelector = () => button;
    patchFail = true;
    await confirm();
    expect(articles[0].status).toBe('draft');
    expect(renderKB()).toContain('1 selected');
    patchFail = false; patchRelease = true;
    actions['kb.publishSelected']();
    const callback = confirm;
    const pending = callback();
    await callback();
    expect(patchCalls).toHaveLength(2);
    patchRelease(); await pending; patchRelease = null;
    expect(articles[0].status).toBe('published');
    expect(articles[1].status).toBe('draft');
    expect(articles[2].status).toBe('draft');
    expect(renderKB()).toContain('0 selected');
    actions['kb.setCat']({ cat: 'all' });
    window.isAdmin = () => false;
    renderKB();
    actions['kb.selectMatching']();
    expect(renderKB()).not.toContain('kb.publishSelected');
    const previousConfirm = confirm;
    actions['kb.publishSelected']();
    expect(confirm).toBe(previousConfirm);
    window.isAdmin = () => true;
  } finally {
    document.getElementById = originalGetElementById;
    document.querySelector = originalQuerySelector;
    window.isAdmin = originalIsAdmin;
    actions['kb.setCat']({ cat: 'all' });
  }
});

test('review filters and publishing preserve drafts on failure and ignore late workspace responses', async () => {
  jwt = 'session'; workspace = 'brand-a';
  articles.splice(0, articles.length,
    { id: 'KB-draft', _uuid: 'draft-uuid', title: 'Review me', body: 'Policy', category: 'Help', status: 'draft', author: 'Jodi' },
    { id: 'KB-live', _uuid: 'live-uuid', title: 'Live policy', body: 'Policy', category: 'Help', status: 'published' },
    { id: 'KB-old', _uuid: 'old-uuid', title: 'Old policy', body: 'Policy', category: 'Help', status: 'archived' });
  expect(renderKB()).toContain('Awaiting review');
  actions['kb.setStatus']({ status: 'draft' });
  expect(renderKB()).toContain('Review me');
  expect(renderKB()).not.toContain('Live policy');
  actions['kb.setStatus']({ status: 'published' });
  expect(renderKB()).toContain('Live policy');
  expect(renderKB()).not.toContain('Review me');
  actions['kb.setStatus']({ status: 'all' });
  patchFail = true;
  actions['kb.publish']({ id: 'KB-draft' });
  expect(modalLabel).toBe('Publish article');
  await confirm();
  expect(articles[0].status).toBe('draft');
  patchFail = false;
  patchRelease = true;
  const pending = confirm();
  const count = patchCalls.length;
  await confirm();
  expect(patchCalls).toHaveLength(count);
  workspace = 'brand-b'; patchRelease(); await pending;
  expect(articles[0].status).toBe('draft');
  workspace = 'brand-a'; patchRelease = null;
  actions['kb.publish']({ id: 'KB-draft' });
  await confirm();
  expect(patchCalls.at(-1)).toEqual({ path: '/api/v1/kb-articles/draft-uuid', body: { status: 'published' } });
  expect(articles[0].status).toBe('published');
  expect(articles[0].author).toBe('Jodi');
  actions['kb.edit']({ id: 'KB-draft' });
  await confirm();
  expect(articles[0].updated).toBe('2026-09-15T12:00:00Z');
  const prior = patchCalls.length;
  actions['kb.publish']({ id: 'KB-live' });
  expect(patchCalls).toHaveLength(prior);
});
