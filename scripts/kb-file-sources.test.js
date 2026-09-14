// Run separately so module mocks cannot affect other suites.
import { test, expect, mock } from 'bun:test';

const actions = {};
let modal,
  uploaded,
  sources = [],
  source;
let active = true,
  releaseUpload;
const dialog = {
  classList: { add() {} },
  setAttribute() {},
  querySelector: () => ({ focus() {} }),
};
globalThis.window = { escHtml: String, escAttr: String };
globalThis.document = {
  getElementById: (id) => ({
    value: {
      'ks-title': 'Policy',
      'ks-category': 'General',
      'ks-language': 'en',
      'ks-url': 'https://example.com/policy',
    }[id],
    files: [new File(['policy'], 'policy.pdf')],
    isConnected: true,
    focus() {},
    closest: () => dialog,
  }),
};
mock.module('../web/js/core/api-client.js', () => ({
  getJwt: () => 'session',
  getWorkspaceId: () => 'workspace',
  apiGet: async (path) =>
    path.endsWith('/knowledge-sources') ? { sources } : { source, versions: [] },
  apiPost: async (path, input) => {
    uploaded = { path, input };
    source = { id: 'url', kind: 'url', title: 'Policy', locator: input.url };
    return { source };
  },
  apiPatch: async (path, input) => {
    uploaded = { path, input };
  },
  apiDelete() {},
  apiCall: async (path, options) => {
    uploaded = { ...options, path };
    if (releaseUpload)
      await new Promise((resolve) => {
        releaseUpload = resolve;
      });
    source = { id: 'file', kind: 'file', title: 'Policy' };
    return { source };
  },
}));
mock.module('../web/js/kb/file-picker.js', () => ({
  knowledgeFilePickerHtml: () => '<input type="file">',
  attachKnowledgeFilePicker: () => ({
    getFile: () => new File(['policy'], 'policy.pdf'),
    setBusy() {},
    isActive: () => active,
  }),
}));
mock.module('../web/js/core/modal.js', () => ({
  showModal: (title, body, submit) => {
    modal = { title, body, submit };
  },
  closeModal() {},
  showDangerConfirm() {},
}));
mock.module('../web/js/core/event-delegation.js', () => ({
  registerActions: (registered) => Object.assign(actions, registered),
}));
mock.module('../web/js/core/toast.js', () => ({ showToast() {} }));
mock.module('../web/js/core/bootstrap.js', () => ({ loadWorkspaceData() {} }));
mock.module('../web/js/core/router.js', () => ({ renderPage() {} }));
const { openKnowledgeSources } = await import('../web/js/kb/sources.js');

test('source management exposes websites and retains file controls', async () => {
  const website = {
    id: 'url',
    kind: 'url',
    title: 'Website',
    locator: 'https://example.com',
    auto_refresh: false,
  };
  sources = [website, { id: 'file', kind: 'file', title: 'Policy', locator: 'policy.pdf' }];
  await openKnowledgeSources();
  expect(modal.title).toBe('Knowledge sources');
  expect(modal.body).toContain('policy.pdf');
  expect(modal.body).toContain('Website');
  expect(modal.body).toContain('Enable hourly checks');
  expect(modal.body).toContain('Replace file');
  source = website;
  await actions['ks.review']({ id: 'url' });
  expect(modal.body).toContain('https://example.com');
  expect(modal.body).toContain('Refresh now');
  expect(modal.body).not.toMatch(/Download original|Replace file/);
});

test('website form submits JSON with automatic checks off by default', async () => {
  actions['ks.url']();
  expect(modal.title).toBe('Add website page');
  expect(modal.body).toContain('ks-url');
  expect(modal.body).not.toContain('type="file"');
  await modal.submit();
  expect(uploaded.input.url).toBe('https://example.com/policy');
  expect(uploaded.input.auto_refresh).toBe(false);
  expect(modal.title).toBe('Review: Policy');
  await actions['ks.auto']({ id: 'url', enabled: 'true' });
  expect(uploaded).toEqual({
    path: '/api/v1/knowledge-sources/url',
    input: { auto_refresh: true },
  });
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

test('replacement submits to the same source without metadata and blocks repeated submissions', async () => {
  source = { id: 'file', kind: 'file', title: 'Policy', locator: 'old.pdf' };
  await actions['ks.replace']({ id: 'file' });
  expect(modal.title).toBe('Replace file: Policy');
  expect(modal.body).toContain('old.pdf');
  expect(modal.body).not.toContain('ks-title');
  const submit = modal.submit;
  releaseUpload = true;
  const pending = submit();
  await submit();
  expect(uploaded.path).toBe('/api/v1/knowledge-sources/file/replace');
  expect([...uploaded.form.keys()]).toEqual(['file']);
  releaseUpload();
  await pending;
  releaseUpload = null;
  expect(modal.title).toBe('Review: Policy');
  active = false;
  uploaded = null;
  await submit();
  expect(uploaded).toBeNull();
  active = true;
});
