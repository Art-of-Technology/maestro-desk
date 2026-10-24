import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('web/js/settings/personal-appearance.js', 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
function setup() {
  const app = { dataset: {} }, actions = {}, changes = {}, reads = [], writes = [];
  const context = { SESSION: { userId: 'synthetic-user' }, CURRENT_PAGE: 'settings', SETTINGS_TAB: 'display',
    AbortSignal, workspace: 'a', jwt: 'synthetic-token',
    getJwt: () => context.jwt, getWorkspaceId: () => context.workspace,
    apiGet: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    apiPatch: (path, body) => new Promise((resolve, reject) => writes.push({ path, body, resolve, reject })),
    document: { getElementById: id => id === 'app' ? app : null, querySelectorAll: () => [] },
    refreshSidebar() {}, renderPage() {},
    registerActions: map => Object.assign(actions, map), registerChangeActions: map => Object.assign(changes, map),
  };
  runInNewContext(source, context);
  return { context, app, actions, reads, writes,
    choose: (name, value) => changes['appearance.choose']({}, { name, value }),
    load: async value => { reads.at(-1).resolve({ user: value }); await Promise.resolve(); },
  };
}
const defaults = { navigation_position: 'left', colour_scheme: 'violet' };
test('preview, cancel and defaults never write; only Save persists both validated preferences', async () => {
  const s = setup(); s.context.ensurePersonalAppearance(); await s.load(defaults);
  s.choose('navigation_position', 'top'); s.choose('colour_scheme', 'teal');
  expect(s.app.dataset).toEqual({ navigation: 'top', colourScheme: 'teal' });
  expect(s.writes).toHaveLength(0);
  s.actions['appearance.cancel']();
  expect(s.app.dataset.navigation).toBe('left');
  s.choose('colour_scheme', 'blue');
  const saving = s.actions['appearance.save']();
  expect(s.writes[0]).toMatchObject({ path: '/api/v1/me', body: { ...defaults, colour_scheme: 'blue' } });
  s.writes[0].resolve({}); await saving;
  s.actions['appearance.defaults']();
  expect(s.app.dataset.colourScheme).toBe('violet');
  expect(s.writes).toHaveLength(1);
  s.actions['appearance.cancel'](); expect(s.app.dataset.colourScheme).toBe('blue');
});
test('late loads and saves cannot repaint a replacement account or workspace', async () => {
  const s = setup(); s.context.ensurePersonalAppearance();
  const oldLoad = s.reads[0];
  s.context.workspace = 'b'; s.context.ensurePersonalAppearance(); await s.load(defaults);
  oldLoad.resolve({ user: { navigation_position: 'top', colour_scheme: 'teal' } }); await Promise.resolve();
  expect(s.app.dataset.navigation).toBe('left');
  s.choose('colour_scheme', 'teal'); const saving = s.actions['appearance.save']();
  s.context.SESSION = { userId: 'another-synthetic-user' }; s.context.ensurePersonalAppearance(); await s.load(defaults);
  s.writes[0].resolve({}); await saving;
  expect(s.app.dataset.colourScheme).toBe('violet');
});
test('a failed load blocks saving and a failed save leaves the original preference intact', async () => {
  const s = setup(); s.context.ensurePersonalAppearance();
  s.reads[0].reject(Error('offline')); await Promise.resolve();
  s.choose('colour_scheme', 'teal'); await s.actions['appearance.save']();
  expect(s.writes).toHaveLength(0);
  expect(s.context.renderPersonalAppearance()).toContain('Try again');
  s.actions['appearance.retry'](); await s.load(defaults);
  s.choose('colour_scheme', 'teal'); const saving = s.actions['appearance.save']();
  s.writes[0].reject(Error('offline')); await saving;
  expect(s.context.renderPersonalAppearance()).toContain('Couldn’t save your appearance');
  s.actions['appearance.cancel'](); expect(s.app.dataset.colourScheme).toBe('violet');
});
test('leaving and reopening during a save cannot undo its eventual successful result', async () => {
  const s = setup(); s.context.ensurePersonalAppearance(); await s.load(defaults);
  s.choose('navigation_position', 'top'); const saving = s.actions['appearance.save']();
  s.context.cancelAppearancePreview();
  s.writes[0].resolve({}); await saving;
  expect(s.app.dataset.navigation).toBe('top');
  expect(s.context.renderPersonalAppearance()).toContain('All changes saved');
});
