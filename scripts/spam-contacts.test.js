import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/settings/spam-contacts.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
const contact = { id: 'contact', display_id: 'C1', first_name: '<Name>', email: 'a@example.test' };
function harness() {
  const actions = {}, calls = [], saves = [], cached = { _uuid: contact.id, isSpam: true };
  const control = { workspace: 'workspace', jwt: 'jwt', allowed: true, response: { contacts: [contact], next_offset: null }, fail: false, hold: null, confirm: null, closed: 0 };
  const list = { innerHTML: '' }, history = { innerHTML: '' }, submit = { disabled: false }, input = { value: '' };
  const root = { isConnected: true, querySelector: selector => selector === '[data-spam-list]' ? list : selector === '[data-spam-history]' ? history : selector === 'input' ? input : submit };
  const button = { isConnected: true, disabled: false }, result = { isConnected: true, textContent: '', closest: () => ({ querySelector: () => button }) };
  const esc = s => String(s).replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const context = { window: { escHtml: esc, escAttr: esc }, getJwt: () => control.jwt, getWorkspaceId: () => control.workspace,
    can: () => control.allowed, registerActions: map => Object.assign(actions, map), formatRoute: () => '#/customers/contact',
    CUSTOMERS: [cached], showToast() {}, queueMicrotask() {},
    showModal: (_t, _b, fn) => { control.confirm = fn; }, closeModal: () => { control.closed++; },
    document: { getElementById: () => result },
    apiGet: async path => { calls.push(path); if (control.hold) await control.hold; if (control.fail) throw Error('Failed'); return control.response; },
    apiDelete: async path => { saves.push(path); if (control.hold) await control.hold; if (control.fail) throw Error('Failed'); },
  };
  const api = runInNewContext(source + '\n({load, loadHistory, settingsSpamContacts, states})', context);
  const state = { workspace: 'workspace', jwt: 'jwt', rows: [contact], q: '', offset: 0, next: null, busy: false };
  api.states.set(root, state);
  return { ...api, state, actions, control, calls, saves, cached, list, history, root, result, button, el: { closest: () => root } };
}

test('spam list distinguishes empty and error, escapes names and pages server results', async () => {
  const h = harness(); await h.load(h.root, h.state);
  expect(h.list.innerHTML).toContain('&lt;Name>'); expect(h.list.innerHTML).toContain('Not recorded');
  h.state.q = 'a+b@example.test'; h.state.next = 50;
  await h.actions['spamContacts.next']({}, h.el);
  expect(h.calls.at(-1)).toContain('q=a%2Bb%40example.test&offset=50');
  h.control.fail = true; await h.load(h.root, h.state);
  expect(h.list.innerHTML).toContain('Try again'); expect(h.list.innerHTML).not.toContain('No contacts');
  h.control.fail = false; h.state.offset = 0; h.control.response = { contacts: [], next_offset: null };
  await h.actions['spamContacts.retry']({}, h.el); expect(h.list.innerHTML).toContain('No matching');
});

test('spam list and history reject late workspace responses and missing permissions', async () => {
  const h = harness(); let resolve; h.control.hold = new Promise(r => { resolve = r; });
  const request = h.load(h.root, h.state); h.control.workspace = 'other'; resolve(); await request;
  expect(h.list.innerHTML).not.toContain('&lt;Name>');
  h.control.allowed = false; expect(h.settingsSpamContacts()).toContain('do not have access');
  h.control.allowed = true; h.control.workspace = 'workspace'; h.control.response = { events: [{ action: 'customer.spam_marked', actor: '<Agent>' }], next_offset: null };
  h.control.hold = new Promise(r => { resolve = r; });
  const first = h.actions['spamContacts.history']({ id: 'contact' }, h.el);
  h.state.history = { id: 'different' }; resolve(); await first;
  expect(h.history.innerHTML).not.toContain('&lt;Agent>');
});

test('unmark waits for confirmation, prevents duplicate saves and retains state on failure', async () => {
  const h = harness(); h.actions['spamContacts.unmark']({ id: 'contact' }, h.el);
  expect(h.saves).toHaveLength(0);
  let resolve; h.control.hold = new Promise(r => { resolve = r; }); h.control.fail = true;
  const save = h.control.confirm(); await h.control.confirm();
  expect(h.saves).toHaveLength(1); expect(h.button.disabled).toBe(true);
  resolve(); await save;
  expect(h.cached.isSpam).toBe(true); expect(h.control.closed).toBe(0); expect(h.result.textContent).toBe('Failed');
  h.control.hold = null; h.control.fail = false; h.control.response = { contacts: [], next_offset: null };
  await h.control.confirm(); expect(h.cached.isSpam).toBe(false); expect(h.control.closed).toBe(1);
  expect(h.list.innerHTML).toContain('No contacts are marked');
});

test('unmark cannot repaint or alter cached contacts after a workspace switch', async () => {
  const h = harness(); h.actions['spamContacts.unmark']({ id: 'contact' }, h.el);
  let resolve; h.control.hold = new Promise(r => { resolve = r; });
  const save = h.control.confirm(); h.control.workspace = 'other'; resolve(); await save;
  expect(h.cached.isSpam).toBe(true); expect(h.control.closed).toBe(0); expect(h.calls).toHaveLength(0);
});

test('history loads more and retries failures without claiming no audit events', async () => {
  const h = harness(); h.control.response = { events: [{ action: 'customer.spam_marked', actor: '<Agent>' }], next_offset: 50 };
  await h.actions['spamContacts.history']({ id: 'contact' }, h.el);
  expect(h.history.innerHTML).toContain('&lt;Agent>');
  h.control.response = { events: [{ action: 'customer.spam_unmarked', actor: 'Reviewer' }], next_offset: null };
  await h.actions['spamContacts.moreHistory']({}, h.el);
  expect(h.calls.at(-1)).toContain('offset=50'); expect(h.history.innerHTML).toContain('Marked as spam'); expect(h.history.innerHTML).toContain('Unmarked as spam');
  h.control.fail = true; await h.actions['spamContacts.retryHistory']({}, h.el);
  expect(h.history.innerHTML).toContain('Couldn’t load'); expect(h.history.innerHTML).not.toContain('No marking');
  h.control.fail = false; await h.actions['spamContacts.retryHistory']({}, h.el);
  expect(h.calls.at(-1)).toContain('offset=0'); expect(h.history.innerHTML).toContain('Reviewer');
});

test('an empty last page returns to the first page', async () => {
  const h = harness(); h.state.offset = 50; h.control.response = { contacts: [], next_offset: null };
  await h.load(h.root, h.state);
  expect(h.calls).toHaveLength(2); expect(h.calls.at(-1)).toContain('offset=0'); expect(h.state.busy).toBe(false);
});
