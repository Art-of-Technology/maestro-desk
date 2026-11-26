import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/customers/merge-lookup.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function harness({ get, post, reload, brand = 'brand' } = {}) {
  const actions = {}, inputs = {}, changes = {}, calls = [], selected = [], customers = [];
  const status = { textContent: '', innerHTML: '' }, fieldset = { disabled: false };
  const input = { value: 'person@example.com', addEventListener(type, fn) { this[type] = fn; } };
  const select = { value: 'email' };
  const root = { innerHTML: '', querySelector: selector => ({ input, select, fieldset, '[role="status"]': status })[selector] };
  const state = { root, brand, workspace: 'workspace', jwt: 'jwt', allowed: true };
  const api = runInNewContext(source + '\n({mountMergeLookup})', {
    document: { getElementById: () => state.root }, window: { escHtml: esc }, CUSTOMERS: customers,
    getBrandId: () => state.brand, getWorkspaceId: () => state.workspace, getJwt: () => state.jwt, can: () => state.allowed,
    apiGet: async (...args) => { calls.push(['get', ...args]); return get ? get() : { member: { email: 'person@example.com', userId: 42, firstName: '<Player>' } }; },
    apiPost: async (...args) => { calls.push(['post', ...args]); return post ? post() : { customer: { id: 'target-uuid' } }; },
    loadWorkspaceData: async () => { calls.push(['reload']); if (reload) await reload(); else customers.push({ id: 'C-2', _uuid: 'target-uuid' }); },
    registerActions: map => Object.assign(actions, map), registerInputActions: map => Object.assign(inputs, map), registerChangeActions: map => Object.assign(changes, map),
  });
  api.mountMergeLookup('C-1', id => selected.push(id));
  return { actions, inputs, changes, calls, selected, customers, status, fieldset, input, select, root, state, ...api };
}

test('lookup is read-only; selecting prepares the player and hands off to confirmation without merging', async () => {
  const h = harness();
  await h.actions['mergeLookup.search']();
  expect(h.calls).toEqual([['get', '/api/v1/maestro/players?email=person%40example.com', { brand: true }]]);
  expect(h.status.innerHTML).toContain('&lt;Player>');
  expect(h.status.innerHTML).toContain('Member ID: 42');
  expect(h.selected).toEqual([]);
  await h.actions['mergeLookup.select']();
  expect(h.calls.slice(1)).toEqual([['post', '/api/v1/customers/from-player', { email: 'person@example.com' }, { brand: true }], ['reload']]);
  expect(h.selected).toEqual(['C-2']);
});

test('username and Member ID keys preserve and encode the entered value', async () => {
  for (const [key, value] of [['email', ' User+name '], ['memberId', ' 12345 ']]) {
    const h = harness(); h.select.value = key; h.input.value = value;
    await h.actions['mergeLookup.search']();
    await h.actions['mergeLookup.select']();
    expect(h.calls[0][1]).toBe(`/api/v1/maestro/players?${key}=${encodeURIComponent(value.trim())}`);
    expect(h.calls[1][2]).toEqual({ [key]: value.trim() });
  }
});

test('empty input, missing email, not found and gateway errors never enable selection', async () => {
  for (const failure of ['empty', 'email', 404, 502]) {
    const h = harness({ get: async () => {
      if (failure === 'email') return { member: { userId: 42 } };
      throw Object.assign(new Error('Gateway unavailable'), { status: failure });
    } });
    if (failure === 'empty') h.input.value = ' ';
    await h.actions['mergeLookup.search']();
    await h.actions['mergeLookup.select']();
    expect(h.calls.some(c => c[0] === 'post')).toBe(false);
    expect(h.status.textContent.length).toBeGreaterThan(0);
    expect(h.fieldset.disabled).toBe(false);
  }
});

test('editing either search field invalidates the previous player', async () => {
  for (const type of ['inputs', 'changes']) {
    const h = harness(); await h.actions['mergeLookup.search']();
    h[type]['mergeLookup.clear']();
    await h.actions['mergeLookup.select']();
    expect(h.calls.length).toBe(1);
  }
});

test('closed/replaced dialog, brand, workspace, session or permission changes discard pending lookup', async () => {
  for (const mutation of [s => s.root = null, s => s.root = {}, s => s.brand = 'other', s => s.workspace = 'other', s => s.jwt = 'other', s => s.allowed = false]) {
    let finish;
    const h = harness({ get: () => new Promise(resolve => { finish = resolve; }) });
    const pending = h.actions['mergeLookup.search']();
    mutation(h.state);
    finish({ member: { email: 'other@example.com' } }); await pending;
    await h.actions['mergeLookup.select']();
    expect(h.calls.length).toBe(1);
    expect(h.selected).toEqual([]);
    expect(h.status.innerHTML).toBe('');
  }
});

test('duplicate clicks cannot issue duplicate imports and closing during import stops continuation', async () => {
  let finish;
  const h = harness({ post: () => new Promise(resolve => { finish = resolve; }) });
  await h.actions['mergeLookup.search']();
  const pending = h.actions['mergeLookup.select']();
  await h.actions['mergeLookup.select']();
  h.state.root = null;
  finish({ customer: { id: 'target-uuid' } }); await pending;
  expect(h.calls.filter(c => c[0] === 'post').length).toBe(1);
  expect(h.calls.some(c => c[0] === 'reload')).toBe(false);
  expect(h.selected).toEqual([]);
});

test('self, erased, merged and missing contacts cannot reach confirmation', async () => {
  for (const target of [{ id: 'C-1' }, { erased: true }, { mergedInto: 'C-3' }, { _mergedIntoUuid: 'other' }, null]) {
    const h = harness({ reload: () => {} });
    if (target) h.customers.push({ id: 'C-2', _uuid: 'target-uuid', ...target });
    await h.actions['mergeLookup.search'](); await h.actions['mergeLookup.select']();
    expect(h.selected).toEqual([]);
    expect(h.status.textContent).not.toBe('Preparing contact…');
  }
});

test('workspace changes during refresh do not open confirmation', async () => {
  const h = harness({ reload: () => { h.state.workspace = 'other'; } });
  await h.actions['mergeLookup.search'](); await h.actions['mergeLookup.select']();
  expect(h.selected).toEqual([]);
});

test('import failure is shown and the search remains usable', async () => {
  const h = harness({ post: () => { throw new Error('Could not reach Maestro'); } });
  await h.actions['mergeLookup.search'](); await h.actions['mergeLookup.select']();
  expect(h.status.textContent).toBe('Could not reach Maestro');
  expect(h.fieldset.disabled).toBe(false);
  expect(h.selected).toEqual([]);
});

test('merge picker mounts lookup even with no local candidates', () => {
  const index = readFileSync(new URL('../web/js/customers/index.js', import.meta.url), 'utf8');
  const picker = index.slice(index.indexOf('function showMergeCustomerModal'), index.indexOf('// Server column names'));
  const shown = [];
  runInNewContext(picker + '\nshowMergeCustomerModal("C-1");', {
    CUSTOMERS: [{ id: 'C-1' }], can: () => true, getBrandId: () => 'brand',
    showModal: (...args) => shown.push(args), mountMergeLookup: (...args) => shown.push(args),
  });
  expect(shown[0][1]).toContain('merge-player-lookup');
  expect(shown[1][0]).toBe('C-1');
});
