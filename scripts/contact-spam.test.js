import { beforeEach, expect, mock, test } from 'bun:test';

const tickets = [], contacts = [], requests = [];
let confirm, title, body, label, workspace, failId, failUndo, closed, changed, jwt, statusSettings;
const button = { disabled: false, textContent: '', focus() {} };
const modal = { querySelector: () => button, querySelectorAll: () => [button, reason, note], closest: () => ({dataset:{}}), classList: { add() {} }, setAttribute() {}, addEventListener() {} };
const reason = { value: '', focus() {}, addEventListener() {}, closest: () => modal };
const note = { value: '', focus() {} };
const error = { textContent: '', isConnected: true, closest: () => modal };
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
globalThis.document = { getElementById: id => ({ 'closure-reason': reason, 'closure-note': note, 'closure-error': error })[id] };
globalThis.window = { escHtml: String, escAttr: String };
mock.module('../web/js/core/data.js', () => ({ AGENTS: [], TICKETS: tickets, CUSTOMERS: contacts }));
mock.module('../web/js/core/state.js', () => ({ SESSION: { userId: 'agent' }, CURRENT_TICKET: '1' }));
mock.module('../web/js/core/api-client.js', () => ({
  getWorkspaceId: () => workspace,
  getJwt: () => jwt,
  apiGet: async () => ({ reminder: { pending: false, version: 0, generation: 0 } }),
  apiPut: async (path, data) => ({ reminder: { pending: data.pending, version: data.version + 1, generation: 0 } }),
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
mock.module('../web/js/tickets/status-options.js', () => ({ statusChoice: () => statusSettings,
  DEFAULT_CLOSURE_REASONS: ['spam', 'abuse', 'duplicate', 'other'].map(key => ({ key, label: key[0].toUpperCase() + key.slice(1), is_active: true })) }));
const { showCloseTickets, closureDetails, unmarkSpamContact } = await import('../web/js/tickets/closure.js');

beforeEach(() => {
  workspace = 'one'; failId = 'never'; failUndo = false; closed = false; changed = [];
  jwt = 'session'; statusSettings = null;
  requests.length = 0; error.textContent = ''; reason.value = ''; note.value = '';
  storage.clear();
  button.disabled = false; reason.disabled = false; note.disabled = false; error.isConnected = true;
  tickets.splice(0, tickets.length, ...['1', '2'].map(id => ({ id, _uuid: id, customerId: 'c' + id, status: 'open' })));
  contacts.splice(0, contacts.length, ...['1', '2'].map(id => ({ id: 'c' + id, _uuid: 'c' + id })));
});

test('single spam action preselects the reason, marks its contact and exposes undo', async () => {
  showCloseTickets(['1'], ids => changed.push(...ids), 'spam');
  expect(title).toBe('Mark as spam'); expect(label).toBe('Mark as spam');
  expect(body).toContain('Future emails'); expect(reason.value).toBe('spam');
  await confirm();
  expect(requests).toEqual([{ path: '/api/v1/tickets/1/close', data: { reason: 'spam', note: '', status_option_key: 'closed' } }]);
  expect(tickets[0]).toMatchObject({ status: 'closed', closureReason: 'spam', resolvedAt: null });
  expect(contacts[0].isSpam).toBe(true); expect(changed).toEqual(['1']); expect(closed).toBe(true);
  expect(closureDetails(tickets[0])).toContain('Unmark contact as spam');
  expect(closureDetails(tickets[0])).not.toContain('A new customer reply reopens');
  await unmarkSpamContact('c1');
  expect(contacts[0].isSpam).toBe(false); expect(tickets[0].status).toBe('closed');
});

test('send and close validates the reason before sending and stays open on unconfirmed delivery', async () => {
  let sends = 0;
  showCloseTickets(['1'], null, '', 'closed', async () => { sends++; return false; });
  await confirm(); expect(sends).toBe(0);
  reason.value = 'other'; await confirm();
  expect(sends).toBe(1); expect(requests).toHaveLength(0);
  expect(tickets[0].status).toBe('open'); expect(closed).toBe(false);
  expect(error.textContent).toContain('not confirmed sent'); expect(button.disabled).toBe(false);
  expect(storage.size).toBe(0);
});

test('a failed close after sending offers only a closure retry', async () => {
  let sends = 0; failId = '/1/';
  showCloseTickets(['1'], null, '', 'closed', async () => { sends++; return true; });
  reason.value = 'other'; note.value = 'Internal context'; await confirm();
  expect(sends).toBe(1); expect(tickets[0].status).toBe('open');
  expect(button.textContent).toBe('Retry close only');
  expect(error.textContent).toContain('Reply sent');
  expect([...storage.values()].map(JSON.parse)).toEqual([{pending:true,version:1,generation:0,dirty:false}]);
  expect(reason.disabled).toBe(true); expect(note.disabled).toBe(true);
  failId = 'never'; await confirm();
  expect(sends).toBe(1); expect(requests).toHaveLength(2);
  expect(requests[1].data).toMatchObject({reason:'other',note:'Internal context'});
  expect(tickets[0].status).toBe('closed'); expect(tickets[0].statusSurveyEnabled).toBe(false);
  expect([...storage.values()].map(JSON.parse).every(r=>!r.pending)).toBe(true);
});

test('double confirmation sends once and a workspace switch prevents closure', async () => {
  let sends = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  showCloseTickets(['1'], null, '', 'closed', async () => { sends++; await held; return true; });
  reason.value = 'other'; const first = confirm(); await confirm();
  expect(sends).toBe(1); expect(reason.disabled).toBe(true);
  workspace = 'two'; release(); await first;
  expect(requests).toHaveLength(0); expect(tickets[0].status).toBe('open'); expect(closed).toBe(true);
  expect(storage.size).toBe(0);
});

test('replacing the modal during a send prevents an unintended closure', async () => {
  showCloseTickets(['1'], null, '', 'closed', async () => { error.isConnected = false; return true; });
  reason.value = 'other'; await confirm();
  expect(requests).toHaveLength(0); expect(tickets[0].status).toBe('open');
});

test('an unexpected send error keeps the close dialog usable', async () => {
  showCloseTickets(['1'], null, '', 'closed', async () => { throw Error('Send unavailable'); });
  reason.value = 'other'; await confirm();
  expect(error.textContent).toBe('Send unavailable'); expect(button.disabled).toBe(false);
  expect(requests).toHaveLength(0); expect(tickets[0].status).toBe('open');
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

test('optional closure accepts no reason, while required custom reasons reject missing and retired choices', async () => {
  statusSettings = { reason_required: false, reasons: [] };
  showCloseTickets(['1']); expect(body).toContain('Reason (optional)'); expect(body).not.toContain('Choosing Spam'); await confirm();
  expect(tickets[0].closureReason).toBeNull(); expect(closed).toBe(true);
  statusSettings = { reason_required: true, reasons: [{ key: 'custom-review', label: 'Review complete', is_active: true }, { key: 'retired', label: 'Old', is_active: false }] };
  showCloseTickets(['2']); await confirm(); expect(error.textContent).toBe('Choose a closure reason.');
  reason.value = 'retired'; await confirm(); expect(tickets[1].status).toBe('open');
  reason.value = 'custom-review'; await confirm();
  expect(tickets[1].statusReasonLabel).toBe('Review complete'); expect(tickets[1].closureReason).toBe('custom-review');
});

test('switching user within the same workspace cancels a pending closure', async () => {
  showCloseTickets(['1'], null, 'spam'); jwt = 'other-session'; await confirm();
  expect(requests).toHaveLength(0); expect(tickets[0].status).toBe('open');
});
