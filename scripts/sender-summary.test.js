import { test, expect, mock } from 'bun:test';

let workspace = 'a', jwt = 'one', admin = true, panel, actions, pending = [], queued = [];
mock.module('../web/js/core/api-client.js', () => ({
  getWorkspaceId: () => workspace, getJwt: () => jwt,
  apiGet: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
}));
mock.module('../web/js/core/event-delegation.js', () => ({ registerActions: value => { actions = value; } }));
globalThis.window = { isAdmin: () => admin, escHtml: text => text.replaceAll('<', '&lt;').replaceAll('>', '&gt;') };
globalThis.document = { getElementById: () => panel };
globalThis.queueMicrotask = callback => queued.push(callback);
const { senderSummary } = await import('../web/js/email-branding/sender-summary.js');

test('sender states, retry, escaping and stale brand/session/page responses', async () => {
  const mount = () => {
    if (panel) panel.isConnected = false;
    const markup = senderSummary();
    panel = { isConnected: true, innerHTML: '' };
    return { markup, done: queued.shift()() };
  };
  for (const source of ['workspace', 'platform', 'none']) {
    const { markup, done } = mount();
    expect(markup).toContain('selected inbox');
    expect(markup).toContain('data-tab="sender-domain"');
    pending.shift().resolve({ sender_identity: { source, from_email: '<brand>@example.test' } });
    await done;
    expect(panel.innerHTML).toContain(source === 'none' ? 'not configured' : '&lt;brand&gt;@example.test');
    if (source !== 'none') expect(panel.innerHTML).toContain(source === 'workspace' ? 'Brand domain' : 'Platform fallback');
  }
  let { done } = mount();
  pending.shift().reject(new Error('offline')); await done;
  expect(panel.innerHTML).toContain('Try again');
  done = actions['emailSender.retry']();
  pending.shift().resolve({ sender_identity: { source: 'platform', from_email: 'support@example.test' } }); await done;
  expect(panel.innerHTML).toContain('support@example.test');
  for (const change of [() => { workspace = 'b'; }, () => { jwt = 'two'; }, () => { panel.isConnected = false; }]) {
    ({ done } = mount());
    change();
    pending.shift().resolve({ sender_identity: { source: 'workspace', from_email: 'stale@example.test' } }); await done;
    expect(panel.innerHTML).not.toContain('stale@example.test');
  }
  ({ done } = mount());
  pending.shift().resolve({}); await done;
  expect(panel.innerHTML).toContain('Could not load');
  admin = false;
  expect(senderSummary()).toBe('');
  expect(queued.length).toBe(0);
});
