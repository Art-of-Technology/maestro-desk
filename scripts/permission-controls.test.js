import { beforeEach, expect, mock, test } from 'bun:test';
const session = {};
globalThis.window = { isAdmin: () => false };
mock.module('../web/js/core/state.js', () => ({ SESSION: session }));
const { can, actionPermission, applyPermissionControls } = await import('../web/js/core/permissions.js');
beforeEach(() => { for (const key of Object.keys(session)) delete session[key]; });
test('verified grants override role names and legacy flags', () => {
  Object.assign(session, { role: 'Platform Admin', isAdmin: false, canDelete: true,
    permissions: { 'tickets.reply': false, 'customers.delete': false, 'tickets.note': true } });
  expect(can('tickets.reply')).toBe(false);
  expect(can('customers.delete')).toBe(false);
  expect(can('tickets.note')).toBe(true);
  expect(can('admin.agents')).toBe(false);
  expect(actionPermission({ dataset: { action: 'nt.cancel' } })).toBeNull();
  expect(actionPermission({ dataset: { action: 'nt.closePreview' } })).toBeNull();
});
test('blank-ticket deletion keeps its legacy exception until explicit permissions are saved', () => {
  Object.assign(session, { permissions: { 'tickets.delete': false }, permissionsLegacy: true });
  const element = { dataset: { action: 'td.deleteTicket', blankTicket: 'true' } };
  expect(actionPermission(element)).toBeNull();
  session.permissionsLegacy = false;
  expect(actionPermission(element)).toBe('tickets.delete');
});
test('combined send-and-close controls require every grant and choose the correct compose tab', () => {
  session.permissions = { 'tickets.reply': true, 'tickets.close': false, 'tickets.note': false };
  const button = { dataset: { action: 'td.sendAnd', permission: 'tickets.reply tickets.close' }, disabled: false, setAttribute() {} };
  applyPermissionControls({ querySelectorAll: () => [button] });
  expect(button.disabled).toBe(true);
  expect(actionPermission({ dataset: { action: 'td.setComposeTab', tab: 'note' } })).toBe('tickets.note');
});
