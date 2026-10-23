import { beforeEach, expect, mock, test } from 'bun:test';

const listeners = {}, actions = {};
const fields = Object.fromEntries(['login-form', 'login-email', 'login-password', 'login-submit', 'login-error', 'login-picker'].map(id => [id, {
  value: '', style: {}, disabled: false, addEventListener: (type, fn) => { listeners[id + ':' + type] = fn; },
}]));
const me = { user: { id: 'synthetic-user' }, memberships: [
  { workspace_id: 'one', workspace_name: 'One' }, { workspace_id: 'two', workspace_name: 'Two' },
] };
const signIn = mock(async () => me);
mock.module('../web/js/core/auth-client.js', () => ({ signIn, rehydrateUser() {}, signOut() {} }));
mock.module('../web/js/core/api-client.js', () => ({ setWorkspaceId() {}, getWorkspaceId() {}, setWorkspaceSlug() {}, setBrandId() {}, apiGet() {} }));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions: map => Object.assign(actions, map) }));
mock.module('../web/js/core/bootstrap.js', () => ({ loadWorkspaceData() {} }));
mock.module('../web/js/auth/platform-admin.js', () => ({ enterGod() {} }));
mock.module('../web/js/core/url-navigation.js', () => ({ requestedRoute() {}, resumeUrlRouting() {}, discardRequestedRoute() {} }));
mock.module('../web/js/core/toast.js', () => ({ showToast() {} }));
mock.module('../web/js/guides/index.js', () => ({ maybeStartGuides() {} }));
globalThis.document = { getElementById: id => fields[id] };
await import('../web/js/auth/agent-login.js');

function submit() {
  const event = { preventDefault: mock(() => {}) };
  const result = listeners['login-form:submit'](event);
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  return result;
}
beforeEach(() => {
  signIn.mockReset(); signIn.mockImplementation(async () => me);
  for (const field of Object.values(fields)) { field.value = ''; field.disabled = false; field.style = {}; }
});
test('reads autofilled credentials on submit without input events and opens the workspace picker', async () => {
  fields['login-email'].value = ' synthetic@example.test ';
  fields['login-password'].value = 'Synthetic password 123!';
  await submit();
  expect(signIn).toHaveBeenCalledTimes(1);
  expect(signIn).toHaveBeenCalledWith('synthetic@example.test', 'Synthetic password 123!');
  expect(fields['login-picker'].style.display).toBe('block');
  expect(fields['login-form'].style.display).toBe('none');
  expect(actions['auth.submitLogin']).toBeUndefined();
  expect(listeners['login-password:keydown']).toBeUndefined();
});
test('rejects missing credentials without navigating or calling sign-in', async () => {
  await submit();
  expect(signIn).not.toHaveBeenCalled();
  expect(fields['login-error'].textContent).toBe('Please enter your email and password.');
});
test('blocks concurrent submits and restores retry after a failed sign-in', async () => {
  fields['login-email'].value = 'synthetic@example.test';
  fields['login-password'].value = 'Synthetic password 123!';
  let reject;
  signIn.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const first = submit();
  await submit();
  expect(signIn).toHaveBeenCalledTimes(1);
  expect(fields['login-submit'].disabled).toBe(true);
  reject(new Error('Synthetic failure'));
  await first;
  expect(fields['login-error'].textContent).toBe('Synthetic failure');
  expect(fields['login-submit'].disabled).toBe(false);
  await submit();
  expect(signIn).toHaveBeenCalledTimes(2);
});
