// Run separately so module mocks cannot affect other suites.
import { test, expect, mock } from 'bun:test';

const actions = {};
let modal, uploaded, sources = [], source;
globalThis.window = { escHtml: String, escAttr: String };
globalThis.document = {
  getElementById: (id) => ({
    value: { 'ks-title': 'Policy', 'ks-category': 'General', 'ks-language': 'en' }[id],
    files: [new File(['policy'], 'policy.pdf')],
    isConnected: true,
  }),
};
mock.module('../web/js/core/api-client.js', () => ({
  getJwt: () => 'session', getWorkspaceId: () => 'workspace',
  apiGet: async (path) => path.endsWith('/knowledge-sources')
    ? { sources } : { source, versions: [] },
  apiPost() {}, apiDelete() {},
  apiCall: async (_path, options) => {
    uploaded = options;
    source = { id: 'file', kind: 'file', title: 'Policy' };
    return { source };
  },
}));
mock.module('../web/js/core/modal.js', () => ({
  showModal: (title, body, submit) => { modal = { title, body, submit }; },
  closeModal() {}, showDangerConfirm() {},
}));
mock.module('../web/js/core/event-delegation.js', () => ({
  registerActions: (registered) => Object.assign(actions, registered),
}));
mock.module('../web/js/core/toast.js', () => ({ showToast() {} }));
mock.module('../web/js/core/bootstrap.js', () => ({ loadWorkspaceData() {} }));
mock.module('../web/js/core/router.js', () => ({ renderPage() {} }));
const { openKnowledgeSources } = await import('../web/js/kb/sources.js');

test('file management hides legacy website sources, even with an older API response', async () => {
  const legacy = { id: 'url', kind: 'url', title: 'Old website', locator: 'https://example.com', auto_refresh: true };
  sources = [legacy, { id: 'file', kind: 'file', title: 'Policy', locator: 'policy.pdf' }];
  await openKnowledgeSources();
  expect(modal.title).toBe('Uploaded files');
  expect(modal.body).toContain('policy.pdf');
  expect(modal.body).not.toMatch(/Old website|https:|hourly|ks\.url|ks\.auto/);
  expect(actions['ks.url']).toBeUndefined();
  expect(actions['ks.auto']).toBeUndefined();
  sources = [legacy];
  await openKnowledgeSources();
  expect(modal.body).toContain('No files yet. Upload a file to get started.');
  source = legacy;
  const previous = modal;
  await actions['ks.review']({ id: 'url' });
  expect(modal).toBe(previous);
});

test('file form uploads multipart data and opens the file review', async () => {
  actions['ks.file']();
  expect(modal.title).toBe('Upload knowledge file');
  expect(modal.body).toContain('type="file"');
  expect(modal.body).not.toMatch(/ks-url|website|hourly/);
  await modal.submit();
  expect(uploaded.method).toBe('POST');
  expect(uploaded.form.get('file').name).toBe('policy.pdf');
  expect(uploaded.form.has('url')).toBe(false);
  expect(uploaded.form.has('auto_refresh')).toBe(false);
  expect(modal.title).toBe('Review: Policy');
  expect(modal.body).toContain('Download original');
  expect(modal.body).not.toContain('Open source page');
});
