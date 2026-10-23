import { beforeEach, expect, mock, test } from 'bun:test';

const actions = {}, changes = {}, listeners = {}, requests = [];
let workspace = 'brand-a', failSave = false, failLoad = false, hydrated = [], renderCount = 0;
const roles = [
  { id: 'admin', name: 'Admin', is_admin: true, permissions_version: 0, permissions: { 'customers.view': true, 'customers.contact_remove': true } },
  { id: 'senior', name: 'Senior Agent', is_admin: false, permissions_version: 2, permissions: { 'customers.view': true, 'customers.contact_remove': true } },
];
const groups = [{ name: 'Contacts', permissions: [['customers.view', 'View profiles'], ['customers.contact_remove', 'Remove email']] }];
const status = { textContent: '' }, saveButton = { disabled: true };
globalThis.document = { getElementById: id => ({ 'permission-save': saveButton, 'permission-save-status': status })[id] || null };
globalThis.window = { isAdmin: () => true, escHtml: value => String(value).replaceAll('<', '&lt;'), escAttr: value => String(value).replaceAll('"', '&quot;'), addEventListener: (name, fn) => { listeners[name] = fn; } };
globalThis.confirm = () => true;
globalThis.requestAnimationFrame = fn => fn();
mock.module('../web/js/core/api-client.js', () => ({
  getWorkspaceId: () => workspace,
  apiGet: async () => { if (failLoad) throw Error('Could not load permissions.'); return { roles: structuredClone(roles), permission_groups: groups }; },
  apiPut: async (path, body) => {
    requests.push({ path, body });
    if (failSave) throw Error('Permissions changed. Reload before saving.');
    return { roles: [...roles.map(row => ({ ...row, permissions: body.roles.find(edit => edit.id === row.id)?.permissions || row.permissions })), ...body.new_roles.map(row => ({ ...row, id: 'created', permissions_version: 0 }))] };
  },
}));
mock.module('../web/js/core/router.js', () => ({ renderPage: () => { renderCount++; } }));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions: map => Object.assign(actions, map), registerChangeActions: map => Object.assign(changes, map) }));
mock.module('../web/js/core/bootstrap.js', () => ({ hydrateRoleRows: rows => { hydrated = structuredClone(rows); } }));
mock.module('../web/js/core/toast.js', () => ({ showToast() {} }));
const { openPermissions, renderPermissions, permissionsOpen } = await import('../web/js/roles/permissions.js');
beforeEach(() => { workspace = 'brand-a'; failSave = false; failLoad = false; hydrated = []; requests.length = 0; renderCount = 0; saveButton.disabled = true; listeners['respovia:auth-scope-changed'](); });

test('checkbox changes stay local until Save, then are sent as a versioned snapshot', async () => {
  await openPermissions();
  changes['roles.editPermission']({ roleId: 'senior', rolePermission: 'customers.contact_remove' }, { checked: false });
  expect(requests).toHaveLength(0);
  expect(hydrated.find(row => row.id === 'senior').permissions['customers.contact_remove']).toBe(true);
  expect(saveButton.disabled).toBe(false);
  await actions['roles.savePermissions']();
  expect(requests).toHaveLength(1);
  expect(requests[0].body.roles).toEqual([{ id: 'senior', version: 2, permissions: { 'customers.view': true, 'customers.contact_remove': false } }]);
  expect(renderPermissions()).toContain('All changes saved');
});
test('new roles open in the matrix and are not created until permissions are saved', async () => {
  await openPermissions('Compliance');
  expect(renderPermissions()).toContain('New · not created until saved');
  expect(renderPermissions()).toContain('permission-new-role');
  expect(requests).toHaveLength(0);
  expect(hydrated.some(row => row.name === 'Compliance')).toBe(false);
  changes['roles.editPermission']({ roleId: 'new-role', rolePermission: 'customers.view' }, { checked: true });
  await actions['roles.savePermissions']();
  expect(requests[0].body.new_roles).toEqual([{ name: 'Compliance', permissions: { 'customers.view': true, 'customers.contact_remove': false } }]);
  expect(hydrated.some(row => row.name === 'Compliance')).toBe(true);
});
test('failed saves retain edits; protected access cannot be toggled', async () => {
  await openPermissions(); failSave = true;
  changes['roles.editPermission']({ roleId: 'admin', rolePermission: 'customers.view' }, { checked: false });
  expect(saveButton.disabled).toBe(true);
  changes['roles.editPermission']({ roleId: 'senior', rolePermission: 'customers.view' }, { checked: false });
  await actions['roles.savePermissions']();
  expect(renderPermissions()).toContain('Reload before saving');
  expect(renderPermissions()).toContain('Unsaved changes');
  expect(hydrated.find(row => row.id === 'senior').permissions['customers.view']).toBe(true);
});
test('many roles remain inside a labelled scroll region and drafts cannot cross brands', async () => {
  await openPermissions();
  const html = renderPermissions();
  expect(html).toContain('class="permission-scroll" role="region"');
  expect(html).toContain('scope="col"');
  expect(html).toContain('data-role-permission="customers.contact_remove"');
  expect(html).not.toContain('data-permission="customers.contact_remove"');
  expect(html).toContain('Always allowed; protected');
  workspace = 'brand-b';
  expect(permissionsOpen()).toBe(false);
  expect(renderPermissions()).toBe('');
});
test('a failed permissions load preserves the new role name and prevents a partial save', async () => {
  failLoad = true;
  await openPermissions('Compliance');
  expect(renderPermissions()).toContain('Could not load permissions.');
  await actions['roles.savePermissions']();
  expect(requests).toHaveLength(0);
  failLoad = false;
  await actions['roles.reloadPermissions']();
  await actions['roles.savePermissions']();
  expect(requests[0].body.new_roles[0].name).toBe('Compliance');
});
