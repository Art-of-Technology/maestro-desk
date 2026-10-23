import { apiGet, apiPut, getWorkspaceId } from '../core/api-client.js';
import { renderPage } from '../core/router.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { hydrateRoleRows } from '../core/bootstrap.js';
import { showToast } from '../core/toast.js';

let editor = null;
const esc = value => window.escHtml(String(value));
const attr = value => window.escAttr(String(value));
function current() { return editor && editor.workspace === getWorkspaceId() ? editor : null; }
export function permissionsOpen() { return Boolean(current()); }
function dirty(state = current()) { return Boolean(state && (state.newRole || state.rows.some(row => !row.is_admin && JSON.stringify(row.permissions) !== JSON.stringify(state.saved[row.id])))); }

export async function openPermissions(newName = null) {
  if (!window.isAdmin()) return;
  if (dirty() && !confirm('Discard your unsaved permission changes?')) return;
  const workspace = getWorkspaceId();
  const state = editor = { workspace, loading: true, rows: [], groups: [], saved: {}, busy: false, error: '',
    newRole: newName ? { id: 'new-role', name: newName, permissions: {} } : null };
  renderPage('roles');
  try {
    const result = await apiGet('/api/v1/roles');
    if (current() !== state) return;
    editor.rows = result.roles;
    editor.groups = result.permission_groups || [];
    editor.saved = Object.fromEntries(result.roles.map(row => [row.id, { ...row.permissions }]));
    if (newName) editor.newRole = { id: 'new-role', name: newName, permissions: Object.fromEntries(editor.groups.flatMap(group => group.permissions.map(([key]) => [key, false]))) };
    hydrateRoleRows(result.roles);
  } catch (err) { if (current() === state) editor.error = err?.message || 'Could not load permissions. Try again.'; }
  finally {
    if (current() === state) {
      editor.loading = false; renderPage('roles');
      if (editor.newRole) requestAnimationFrame(() => document.getElementById('permission-new-role')?.scrollIntoView({ block: 'nearest', inline: 'end' }));
    }
  }
}

export function renderPermissions() {
  const state = current();
  if (!state) return '';
  const rows = [...state.rows, ...(state.newRole ? [state.newRole] : [])];
  const changed = dirty(state);
  return `<div class="page"><div class="topbar"><button type="button" class="btn btn-sm permission-back" data-action="roles.closePermissions" ${state.busy ? 'disabled' : ''}>← Roles</button><div class="tb-title">Role permissions</div></div>
    <div class="page-scroll"><div class="card permission-editor">
      <div class="permission-toolbar"><div><h2 class="card-title">Permissions by role</h2><p>Changes take effect when you save. Brand Admins manage this brand; God Users retain platform access.</p></div>
      <div class="permission-save"><span id="permission-save-status" role="status">${changed ? 'Unsaved changes' : 'All changes saved'}</span><button type="button" id="permission-save" class="btn btn-solid" data-action="roles.savePermissions" ${!changed || !state.groups.length || state.busy || state.loading ? 'disabled' : ''}>${state.busy ? 'Saving…' : 'Save changes'}</button></div></div>
      ${state.error ? `<div class="permission-error" role="alert">${esc(state.error)} <button type="button" class="btn btn-sm" data-action="roles.reloadPermissions" ${state.busy ? 'disabled' : ''}>Reload</button></div>` : ''}
      ${state.loading ? '<p role="status">Loading role permissions…</p>' : `<div class="permission-scroll" role="region" aria-label="Role permission matrix; scroll horizontally for more roles" tabindex="0"><table class="tbl permission-matrix"><caption class="stat-sr-only">Role permissions for the active brand</caption><thead><tr><th scope="col">Permission</th>${rows.map(row => `<th scope="col" ${row.id === 'new-role' ? 'id="permission-new-role"' : ''}>${esc(row.name)}<span>${row.is_admin ? 'Protected · full brand access' : row.id === 'new-role' ? 'New · not created until saved' : 'Customisable'}</span></th>`).join('')}<th scope="col">God User<span>Protected · platform access</span></th></tr></thead><tbody>
        ${state.groups.map(group => `<tr class="permission-group"><th scope="rowgroup" colspan="${rows.length + 2}">${esc(group.name)}</th></tr>${group.permissions.map(([key,label]) => `<tr><th scope="row">${esc(label)}</th>${rows.map(row => `<td>${row.is_admin ? '<span aria-label="Always allowed; protected">✓</span>' : `<label class="permission-check"><input type="checkbox" data-change-action="roles.editPermission" data-role-id="${attr(row.id)}" data-role-permission="${attr(key)}" aria-label="${attr(row.name)}: ${attr(label)}" ${row.permissions[key] ? 'checked' : ''} ${state.busy ? 'disabled' : ''}></label>`}</td>`).join('')}<td><span aria-label="Always allowed; protected">✓</span></td></tr>`).join('')}`).join('')}
        <tr class="permission-group"><th scope="rowgroup" colspan="${rows.length + 2}">Protected administration</th></tr>${['Manage role permissions','Grant Brand Admin access'].map(label => `<tr><th scope="row">${label}</th>${rows.map(row => `<td>${row.is_admin ? '✓' : '—'}</td>`).join('')}<td>✓</td></tr>`).join('')}
        <tr><th scope="row">Grant God User / cross-brand access</th>${rows.map(() => '<td>—</td>').join('')}<td>✓</td></tr>
      </tbody></table></div><p class="permission-hint">Scroll sideways for more roles. Primary and last email protections always apply. Brand-wide reports, contact history and activity require “View all brand tickets”.</p>`}
    </div></div></div>`;
}

function editPermission(ds, input) {
  const state = current();
  if (!state || state.busy || !window.isAdmin()) return;
  const row = state.newRole?.id === ds.roleId ? state.newRole : state.rows.find(row => row.id === ds.roleId);
  if (!row || row.is_admin || !Object.hasOwn(row.permissions, ds.rolePermission)) return;
  row.permissions[ds.rolePermission] = input.checked;
  document.getElementById('permission-save').disabled = !dirty(state);
  document.getElementById('permission-save-status').textContent = dirty(state) ? 'Unsaved changes' : 'All changes saved';
}

async function savePermissions() {
  const state = current();
  if (!state || !state.groups.length || state.busy || !dirty(state) || !window.isAdmin()) return;
  const payload = {
    roles: state.rows.filter(row => !row.is_admin && JSON.stringify(row.permissions) !== JSON.stringify(state.saved[row.id]))
      .map(row => ({ id: row.id, version: row.permissions_version, permissions: row.permissions })),
    new_roles: state.newRole ? [{ name: state.newRole.name, permissions: state.newRole.permissions }] : [],
  };
  state.busy = true; state.error = ''; renderPage('roles');
  try {
    const result = await apiPut('/api/v1/roles/permissions', payload);
    if (current() !== state) return;
    hydrateRoleRows(result.roles);
    state.rows = result.roles; state.saved = Object.fromEntries(result.roles.map(row => [row.id, { ...row.permissions }])); state.newRole = null;
    showToast('Role permissions saved.');
  } catch (err) { if (current() === state) state.error = err?.message || 'Could not save permissions. Your changes are still here.'; }
  finally { if (current() === state) { state.busy = false; renderPage('roles'); } }
}

function closePermissions() {
  if (current()?.busy || dirty() && !confirm('Discard your unsaved permission changes?')) return;
  editor = null; renderPage('roles');
}
// Edits survive internal navigation; a workspace/session change discards that brand's draft.
globalThis.window?.addEventListener?.('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
globalThis.window?.addEventListener?.('respovia:auth-scope-changed', () => { editor = null; });
registerActions({
  'roles.showPermissions': () => openPermissions(),
  'roles.closePermissions': closePermissions,
  'roles.savePermissions': savePermissions,
  'roles.reloadPermissions': () => openPermissions(current()?.newRole?.name || null),
});
registerChangeActions({ 'roles.editPermission': editPermission });
