import { beforeEach, expect, mock, test } from 'bun:test';
let workspace = 'one', fail = false, release, payload, renders = 0;
const channels = [{ _uuid: 'a', name: 'Support', address: 'support@example.test', status: 'active', type: 'email' },
  { _uuid: 'b', name: '<Payments>', address: 'payments@example.test', status: 'active', type: 'email' }];
const tickets = [], storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
const escape = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
globalThis.window = { escHtml: escape, escAttr: escape };
mock.module('../web/js/core/data.js', () => ({ CHANNELS: channels, TICKETS: tickets }));
mock.module('../web/js/core/state.js', () => ({ CURRENT_TICKET: 'TK-1', COMPOSE_TAB: 'reply', SESSION: {userId:'agent'} }));
mock.module('../web/js/core/api-client.js', () => ({ getWorkspaceId: () => workspace, getJwt: () => 'session',
  apiPatch: async (_url, body) => {
    payload = body;
    if (release) await new Promise(resolve => { release = resolve; });
    if (fail) throw Error('The ticket changed. Refresh it before moving it.');
    return { ticket: { channel_id: body.channel_id, updated_at: '2026-09-30T13:00:00Z' }, activity: [] };
  },
}));
mock.module('../web/js/core/modal.js', () => ({ showModal() {}, closeModal() {} }));
mock.module('../web/js/core/toast.js', () => ({ showToast() {} }));
mock.module('../web/js/tickets/detail.js', () => ({ openTicket() { renders++; } }));
const { moveTicketInbox, renderTicketInbox } = await import('../web/js/tickets/inbox.js');
const { replyDraft } = await import('../web/js/tickets/email-details.js');
const { saveDraft, loadDraft, saveDraftRecipients } = await import('../web/js/tickets/drafts.js');
beforeEach(() => {
  workspace = 'one'; fail = false; release = null; renders = 0; storage.clear();
  tickets.splice(0, tickets.length, { id: 'TK-1', _uuid: 'ticket', channelId: 'a', _listUpdatedAt: '2026-09-30T12:00:00Z',
    replyRecipients: { default_sending_channel_id: 'a', to: ['customer@example.test'], source_message_id: 'message',
      sending_inboxes: channels.map(c => ({ id:c._uuid, address:c.address })) } });
});
test('move updates the sender, preserves body/CC, and Undo uses the saved version', async () => {
  const t = tickets[0]; saveDraft(t.id, '<p>Keep this draft</p>');
  saveDraftRecipients(t.id, { ...replyDraft(t), cc: 'colleague@example.test', mode: 'reply_all' });
  const moved = await moveTicketInbox(t, 'b');
  expect(payload.expected_channel_id).toBe('a'); expect(t.channelId).toBe('b');
  expect(replyDraft(t).sending_channel_id).toBe('b');
  expect(replyDraft(t).cc).toBe('colleague@example.test'); expect(replyDraft(t).mode).toBe('reply_all');
  expect(loadDraft(t.id)).toBe('<p>Keep this draft</p>');
  await moveTicketInbox(t, 'a', moved);
  expect(payload.expected_updated_at).toBe(moved.updatedAt); expect(payload.expected_channel_id).toBe('b');
  expect(replyDraft(t).sending_channel_id).toBe('a'); expect(renders).toBe(2);
});
test('failed and late responses cannot change the inbox or another workspace draft', async () => {
  const t = tickets[0]; fail = true;
  expect(await moveTicketInbox(t,'b')).toBeNull(); expect(t.channelId).toBe('a');
  fail = false; release = true;
  const pending = moveTicketInbox(t,'b'); workspace = 'two'; release(); await pending;
  expect(t.channelId).toBe('a'); expect(renders).toBe(0); expect(storage.size).toBe(0);
});
test('remote moves reset a saved sender but retain recipients, and labels escape channel names', () => {
  const t = tickets[0]; saveDraftRecipients(t.id, { ...replyDraft(t), cc:'reviewer@example.test' });
  t.channelId = 'b'; expect(replyDraft(t).sending_channel_id).toBe('b');
  expect(replyDraft(t).cc).toBe('reviewer@example.test');
  expect(renderTicketInbox(t,true)).toContain('&lt;Payments&gt;');
  expect(renderTicketInbox(t,true)).not.toContain('<Payments>');
});
test('existing drafts without an inbox snapshot keep their explicit sender', () => {
  const t = tickets[0];
  const { ticket_channel_id, ...legacy } = replyDraft(t);
  saveDraftRecipients(t.id, { ...legacy, sending_channel_id:'b', sending_address:'payments@example.test' });
  expect(replyDraft(t).sending_channel_id).toBe('b');
  expect(replyDraft(t).ticket_channel_id).toBe('a');
});
