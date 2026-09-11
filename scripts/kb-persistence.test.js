// Run separately: module mocks must not affect the API suite or render smokes.
import { test, expect, mock } from 'bun:test';
const articles = [],
  actions = {};
let jwt = 'session',
  workspace = 'brand-a',
  confirm,
  posts = 0,
  fail = false,
  release;
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
  KB_SELECTED: null,
  SESSION: { name: 'Test' },
  setKbSelected() {},
}));
mock.module('../web/js/core/router.js', () => ({ renderPage() {} }));
mock.module('../web/js/ai/page.js', () => ({ renderMarkdown: String }));
mock.module('../web/js/core/event-delegation.js', () => ({
  registerActions: (a) => Object.assign(actions, a),
  registerInputActions() {},
}));
mock.module('../web/js/core/presence.js', () => ({ startPresence() {} }));
mock.module('../web/js/core/modal.js', () => ({
  showModal: (_t, _b, cb) => {
    confirm = cb;
  },
  closeModal() {},
}));
mock.module('../web/js/kb/sources.js', () => ({}));
mock.module('../web/js/core/api-client.js', () => ({
  getJwt: () => jwt,
  getWorkspaceId: () => workspace,
  apiPatch() {},
  apiDelete() {},
  apiPost: async () => {
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
      },
    };
  },
}));
await import('../web/js/kb/index.js');
test('first live article persists, failures do not fake success, and late responses stay in their workspace', async () => {
  actions['kb.new']();
  await confirm();
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
