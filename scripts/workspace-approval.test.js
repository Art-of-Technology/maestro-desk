import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function login(brands) {
  const elements = Object.fromEntries(['login-form', 'maestro-signin', 'maestro-brand-picker', 'login-error']
    .map(id => [id, { style: {}, classList: { add() {}, remove() {} }, innerHTML: '', textContent: '' }]));
  const calls = [];
  const actions = {};
  const context = createContext({ document: { getElementById: id => elements[id] },
    rehydrateUser: async () => ({ user: { id: 'agent' } }), requestedRoute: () => null,
    apiGet: async () => ({ brands }), apiPost: async (path, body) => { calls.push({ path, body }); return { membership: {} }; },
    setBrandId() {}, enterWorkspaceMembership: async () => calls.push({ enter: true }),
    signOut() {}, registerActions: map => Object.assign(actions, map),
  });
  const source = readFileSync('web/js/auth/maestro-login.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  runInContext(source, context);
  return { elements, calls, actions, run: code => runInContext(code, context) };
}

test('a single new brand waits for an explicit request and renders pending after success', async () => {
  const view = login([{ id: 'brand', name: '<Test>', workspace_status: 'requestable' }]);
  await view.run('detectWorkspaceAndRoute()');
  expect(view.calls).toHaveLength(0);
  expect(view.elements['maestro-brand-picker'].innerHTML).toContain('&lt;Test&gt;');
  expect(view.elements['maestro-brand-picker'].innerHTML).toContain('Request a Respovia workspace');
  await view.actions['maestro.pickBrand']({ idx: '0' });
  expect(view.calls).toEqual([{ path: '/api/v1/maestro/workspace-requests', body: { brandId: 'brand' } }]);
  expect(view.elements['maestro-brand-picker'].innerHTML).toContain('Awaiting approval');
  await view.actions['maestro.pickBrand']({ idx: '0' });
  expect(view.calls).toHaveLength(1);
});

test('one ready brand enters directly; multiple brands remain keyboard-accessible choices', async () => {
  const ready = login([{ id: 'ready', name: 'Existing', workspace_status: 'ready' }]);
  await ready.run('detectWorkspaceAndRoute()');
  expect(ready.calls[0].path).toBe('/api/v1/maestro/select-brand');
  expect(ready.calls[1].enter).toBe(true);
  const multiple = login([{ id: 'one', name: 'One', workspace_status: 'ready' }, { id: 'two', name: 'Two', workspace_status: 'pending' }]);
  await multiple.run('detectWorkspaceAndRoute()');
  expect(multiple.calls).toHaveLength(0);
  expect(multiple.elements['maestro-brand-picker'].innerHTML).toContain('<button type="button" class="auth-account"');
  expect(multiple.elements['maestro-brand-picker'].innerHTML).toContain('Refresh brands');
});

test('admin approval panel escapes names and retains pending requests in Automatic mode', () => {
  const source = readFileSync('web/js/god/index.js', 'utf8');
  const renderer = source.slice(source.indexOf('function renderWorkspaceRegistration()'), source.indexOf('async function refreshWorkspaceRegistration()'));
  for (const automatic of [true, false]) {
    const html = runInContext(`${renderer}; renderWorkspaceRegistration()`, createContext({
      STATE: { registration: { automatic, requests: [{ maestro_brand_id: 'id', brand_name: '<Brand>', organization_name: 'Org', requester_email: 'agent@example.test' }] } },
      escAttr: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'), fmtDate: () => 'Today',
    }));
    expect(html).toContain('&lt;Brand&gt;');
    expect(html).toContain('agent@example.test');
    expect(html).toContain('Pending requests (1)');
    expect(html).toContain('Approve workspace');
    expect(html).toContain('label for="workspace-registration-mode"');
    if (automatic) expect(html).toContain('Pending requests still need your approval');
  }
});
