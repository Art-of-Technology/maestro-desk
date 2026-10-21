import { beforeEach, expect, mock, test } from 'bun:test';

let workspace = 'one', blocked = false, warnings = 0;
const session = { userId: 'agent' };
const storage = new Map();
globalThis.localStorage = {
  getItem(key) { if (blocked === true) throw Error('Blocked'); return storage.get(key) || null; },
  setItem(key, value) { if (blocked) throw Error('Blocked'); storage.set(key, value); },
  removeItem(key) { if (blocked) throw Error('Blocked'); storage.delete(key); },
};
globalThis.document = { getElementById: () => null };
globalThis.window = { escAttr: value => String(value).replaceAll('"', '&quot;') };
mock.module('../web/js/core/state.js', () => ({ SESSION: session }));
mock.module('../web/js/core/api-client.js', () => ({ getWorkspaceId: () => workspace }));
mock.module('../web/js/core/toast.js', () => ({ showToast: () => { warnings++; } }));
const { markCloseReminder, clearCloseReminder, closeReminder } = await import('../web/js/tickets/close-reminder.js');
const ticket = { id: 'TK-001', _uuid: 'ticket-one', status: 'open' };

beforeEach(() => {
  workspace = 'one'; session.userId = 'agent'; blocked = false; warnings = 0;
  clearCloseReminder(ticket); storage.clear();
});
test('reminders store only a marker and survive a fresh ticket object', () => {
  markCloseReminder(ticket);
  expect([...storage.values()]).toEqual(['1']);
  expect(closeReminder({ ...ticket })).toContain('Retry close only');
  expect(closeReminder({ ...ticket, _uuid: 'another-ticket' })).toBe('');
  clearCloseReminder(ticket);
  expect(closeReminder(ticket)).toBe('');
});
test('another workspace or agent cannot see the reminder', () => {
  markCloseReminder(ticket);
  workspace = 'two'; expect(closeReminder(ticket)).toBe('');
  workspace = 'one'; session.userId = 'other'; expect(closeReminder(ticket)).toBe('');
  session.userId = 'agent'; expect(closeReminder(ticket)).toContain('Email sent');
});
test('a confirmed closed or merged ticket clears stale reminders', () => {
  for (const change of [{ status: 'closed' }, { mergedInto: 'TK-002' }]) {
    markCloseReminder(ticket);
    expect(closeReminder({ ...ticket, ...change })).toBe('');
    expect(storage.size).toBe(0);
    expect(closeReminder(ticket)).toBe('');
  }
});
test('blocked browser storage preserves the in-page notice and explains the limit', () => {
  blocked = true; markCloseReminder(ticket);
  expect(warnings).toBe(1);
  expect(closeReminder(ticket)).toContain('Retry close only');
  clearCloseReminder(ticket);
  expect(closeReminder(ticket)).toBe('');
});
test('full storage still shows the reminder when reads are available', () => {
  blocked = 'write'; markCloseReminder(ticket);
  expect(warnings).toBe(1);
  expect(closeReminder(ticket)).toContain('Retry close only');
});
