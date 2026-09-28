import { beforeEach, expect, mock, test } from 'bun:test';

const tickets = [], contacts = [], requests = [];
let confirm, title, body, label, workspace, failId, failUndo, closed, changed;
const button = { disabled: false, textContent: '' };
const modal = { querySelector: () => button, classList: { add() {} }, setAttribute() {}, addEventListener() {} };
const reason = { value: '', focus() {}, addEventListener() {}, closest: () => modal };
const note = { value: '', focus() {} };
const error = { textContent: '', isConnected: true, closest: () => modal };
globalThis.document = { getElementById: id => ({ 'closure-reason': reason, 'closure-note': note, 'closure-error': error })[id] };
globalThis.window = { escHtml: String, escAttr: String };
mock.module('../web/js/core/data.js', () => ({ AGENTS: [], TICKETS: tickets, CUSTOMERS: contacts }));
mock.module('../web/js/core/state.js', () => ({ SESSION: { userId: 'agent' } }));
mock.module('../web/js/core/api-client.js', () => ({
  getWorkspaceId: () => workspace,
  apiPost: async (path, data) => {
    requests.push({ path, data });
    if (path.includes(failId)) throw new Error('Temporary failure');
    return { ticket: { closure_reason: data.reason, closure_note: data.note, closed_at: '2026-09-28T12:00:00Z', closed_by_user_id: 'agent' } };
  },
  apiDelete: async path => { requests.push({ path }); if (failUndo) throw new Error('Undo failed'); },
}));
mock.module('../web/js/core/modal.js', () => ({
  showModal: (heading, html, action, actionLabel) => { title = heading; body = html; confirm = action; label = actionLabel; reason.value = html.includes('value="spam" selected') ? 'spam' : ''; },
  closeModal: () => { closed = true; },
}));
mock.module('../web/js/core/toast.js', () => ({ showToast() {} }));
mock.module('../web/js/core/activity-log.js', () => ({ logTicketEvent() {} }));
mock.module('../web/js/core/ticket-history.js', () => ({ applySavedActivity() {} }));
mock.module('../web/js/tickets/sla.js', () => ({ refreshTicketSLA() {} }));
const { showCloseTickets, closureDetails, unmarkSpamContact } = await import('../web/js/tickets/closure.js');

beforeEach(() => {
  workspace = 'one'; failId = 'never'; failUndo = false; closed = false; changed = [];
  requests.length = 0; error.textContent = ''; reason.value = ''; note.value = '';
  tickets.splice(0, tickets.length, ...['1', '2'].map(id => ({ id, _uuid: id, customerId: 'c' + id, status: 'open' })));
  contacts.splice(0, contacts.length, ...['1', '2'].map(id => ({ id: 'c' + id, _uuid: 'c' + id })));
});

test('single spam action preselects the reason, marks its contact and exposes undo', async () => {
  showCloseTickets(['1'], ids => changed.push(...ids), 'spam');
  expect(title).toBe('Mark as spam'); expect(label).toBe('Mark as spam');
  expect(body).toContain('Future emails'); expect(reason.value).toBe('spam');
  await confirm();
  expect(requests).toEqual([{ path: '/api/v1/tickets/1/close', data: { reason: 'spam', note: '' } }]);
  expect(tickets[0]).toMatchObject({ status: 'closed', closureReason: 'spam', resolvedAt: null });
  expect(contacts[0].isSpam).toBe(true); expect(changed).toEqual(['1']); expect(closed).toBe(true);
  expect(closureDetails(tickets[0])).toContain('Unmark contact as spam');
  expect(closureDetails(tickets[0])).not.toContain('A new customer reply reopens');
  await unmarkSpamContact('c1');
  expect(contacts[0].isSpam).toBe(false); expect(tickets[0].status).toBe('closed');
});

test('bulk spam keeps failed tickets selected and retries only failures', async () => {
  failId = '/2/';
  showCloseTickets(['1', '2'], ids => changed.push(...ids), 'spam');
  await confirm();
  expect(changed).toEqual(['1']); expect(tickets[1].status).toBe('open');
  expect(contacts[1].isSpam).toBeUndefined(); expect(error.textContent).toContain('Temporary failure');
  expect(button.textContent).toBe('Retry failed tickets');
  failId = 'never'; await confirm();
  expect(requests.map(r => r.path)).toEqual(['/api/v1/tickets/1/close', '/api/v1/tickets/2/close', '/api/v1/tickets/2/close']);
  expect(changed).toEqual(['1', '2']); expect(contacts.every(c => c.isSpam)).toBe(true);
});

test('closed tickets can mark a contact; generic closure does not mark it, and failed undo preserves the flag', async () => {
  tickets[0].status = 'closed';
  showCloseTickets(['1'], null, 'spam'); await confirm();
  expect(contacts[0].isSpam).toBe(true);
  failUndo = true; await unmarkSpamContact('c1'); expect(contacts[0].isSpam).toBe(true);
  showCloseTickets(['2']); reason.value = 'duplicate'; await confirm();
  expect(contacts[1].isSpam).toBeUndefined();
});

test('switching workspace before confirmation does not write to the new workspace', async () => {
  showCloseTickets(['1', '2'], null, 'spam'); workspace = 'two'; await confirm();
  expect(requests).toHaveLength(0); expect(tickets.every(t => t.status === 'open')).toBe(true);
});
