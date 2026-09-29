import { test, expect, mock } from 'bun:test';

const actions = {};
const fields = Object.fromEntries(['sp-password', 'sp-password-confirm', 'sp-error', 'sp-confirm', 'sp-submit'].map(id => [id, {
  value: '', style: {}, setAttribute() {}, removeAttribute() {}, focus() { this.focused = true; },
}]));
const reset = mock(async () => true);
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions: map => Object.assign(actions, map) }));
mock.module('../web/js/core/auth-client.js', () => ({ resetPassword: reset, requestPasswordReset: async () => {} }));
globalThis.document = { getElementById: id => fields[id] };
const { beginSetPassword } = await import('../web/js/auth/index.js');

test('password confirmation blocks typos and only submits a matching valid password', async () => {
  beginSetPassword('invite-token');
  fields['sp-password'].value = 'A-valid-password-123!';
  fields['sp-password-confirm'].value = 'A-valid-password-123';
  await actions['auth.submitSetPassword']();
  expect(reset).not.toHaveBeenCalled();
  expect(fields['sp-error'].textContent).toContain('Passwords do not match');
  expect(fields['sp-password-confirm'].focused).toBe(true);

  fields['sp-password'].value = fields['sp-password-confirm'].value = 'Short-123!';
  await actions['auth.submitSetPassword']();
  expect(reset).not.toHaveBeenCalled();

  fields['sp-password'].value = fields['sp-password-confirm'].value = 'A-valid-password-123!';
  await actions['auth.submitSetPassword']();
  expect(reset).toHaveBeenCalledWith('invite-token', 'A-valid-password-123!');
  expect(fields['sp-confirm'].style.display).toBe('block');
});
