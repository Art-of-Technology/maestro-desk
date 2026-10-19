import { test, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

let savedRecipients = null;
mock.module('../web/js/tickets/drafts.js', () => ({ loadDraftRecipients: () => savedRecipients, saveDraftRecipients: (_id, value) => { savedRecipients = value; } }));
const { renderEmailDetails, renderEmailRetry, messageTime, renderReplyRecipients, replyDraft, changeReplyMode, replyRecipientPayload } = await import('../web/js/tickets/email-details.js');

globalThis.window ||= globalThis;
window.escHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
window.escAttr = value => window.escHtml(value).replaceAll('"', '&quot;');

test('delivery labels count every distinct To and CC recipient and show receipt timestamps', () => {
  const message = { createdAt: '2026-10-16T12:00:00Z', email: { status: 'sent', sent_at: '2026-10-16T12:00:00Z',
    to: ['one@example.test'], cc: ['ONE@example.test', 'two@example.test'] } };
  expect(messageTime(message)).toStartWith('Sent ');
  message.email.delivered_recipients = { 'one@example.test': '2026-10-16T12:01:00Z' };
  expect(messageTime(message)).toStartWith('Partially delivered ');
  expect(renderEmailDetails(message)).toContain('Delivery confirmed');
  message.email.delivered_recipients['two@example.test'] = '2026-10-16T12:02:00Z';
  expect(messageTime(message)).toStartWith('Delivered ');
});

test('only definitively failed public replies offer a retry on the original message', () => {
  const message = { _uuid: 'original-id', r: 'agent', email: { status: 'saved', delivery_state: 'failed' } };
  expect(renderEmailRetry(message)).toContain('Retry sending');
  expect(renderEmailRetry(message)).toContain('data-message-id="original-id"');
  for (const patch of [{ r: 'note' }, { forwarded: true }, { mergedFrom: 'T1' }, { email: { status: 'sent' } }, { email: { status: 'saved' } }, { email: { status: 'saved', delivery_state: 'sending' } }]) {
    expect(renderEmailRetry({ ...message, ...patch })).toBe('');
  }
  const unknown = { ...message, createdAt: '2026-10-16T12:00:00Z', email: { status: 'saved', delivery_state: 'unknown' } };
  expect(renderEmailRetry(unknown)).toContain('Delivery could not be confirmed');
  expect(renderEmailRetry(unknown)).not.toContain('<button');
  expect(messageTime(unknown)).toContain('Delivery unconfirmed');
});

test('incoming email shows the receiving inbox once, with sender, CC and reply-to', () => {
  const html = renderEmailDetails({ email: { status: 'received', from: 'customer@example.test',
    to: ['support@example.test'], received_via: 'support@example.test', cc: ['colleague@example.test'], reply_to: 'reply@example.test' } });
  expect(html.match(/support@example.test/g)).toHaveLength(1);
  expect(html).toContain('Received via');
  expect(html).toContain('<dt>From</dt><dd>customer@example.test</dd>');
  expect(html).toContain('<dt>CC</dt><dd>colleague@example.test</dd>');
  expect(html).toContain('<dt>Reply to</dt><dd>reply@example.test</dd>');
  expect(html).not.toContain('<dt>To</dt>');
});

test('outgoing email keeps its To recipients', () => {
  const html = renderEmailDetails({ email: { status: 'sent', from: 'support@example.test', to: ['customer@example.test'] } });
  expect(html).toContain('<dt>To</dt><dd>customer@example.test</dd>');
  expect(html).not.toContain('Received via');
});

test('details collapse and recipient count follow the displayed addresses', () => {
  const email = { from: 'sender@example.test', to: ['one@example.test', 'two@example.test', 'three@example.test'],
    cc: ['copy@example.test'], received_via: 'support@example.test' };
  expect(renderEmailDetails({ email: { ...email, status: 'received' } })).not.toContain('<details>');
  expect(renderEmailDetails({ email: { ...email, status: 'sent' } })).toContain('Email details · 4 recipients');
  expect(renderEmailDetails({ email: { ...email, status: 'received', cc: [...email.to, ...email.cc] } })).toContain('Email details · 4 recipients');
});

test('missing inbox is labelled and incoming values stay escaped', () => {
  const html = renderEmailDetails({ email: { status: 'received', from: '<sender>', to: [] } });
  expect(html).toContain('Inbox not recorded');
  expect(html).toContain('&lt;sender&gt;');
  expect(renderEmailDetails({ r: 'note' })).toBe('');
});

function replyTicket() {
  savedRecipients = null;
  return { id: 'TK-1', _uuid: 'ticket', channelId: 'support', replyRecipients: {
    source_message_id: 'message', to: ['customer@example.test'], cc: ['colleague@example.test'],
    sending_inboxes: [{ id: 'support', address: 'support@example.test' }],
  } };
}

test('recipient header keeps From, reply mode and To visible while empty Cc is collapsed', () => {
  const t = replyTicket(), html = renderReplyRecipients(t);
  expect(html).toContain('class="reply-sender-row"');
  expect(html).toContain('aria-label="Reply mode"');
  expect(html).toContain('customer@example.test');
  expect(html).toContain('aria-expanded="false" aria-controls="reply-cc-field-TK-1"');
  expect(html).toContain('id="reply-cc-field-TK-1" hidden');
  expect(html).not.toContain('reply-recipient-warning');
  expect(html).not.toContain('Check who will receive this email before sending.');
});

test('saved Cc and Reply all recipients stay expanded and keep their send payload', () => {
  const t = replyTicket();
  savedRecipients = { ...replyDraft(t), cc: 'saved@example.test' };
  expect(renderReplyRecipients(t)).toContain('aria-expanded="true"');
  expect(renderReplyRecipients(t)).not.toContain('id="reply-cc-field-TK-1" hidden');
  expect(replyRecipientPayload(t).cc).toEqual(['saved@example.test']);
  changeReplyMode(t, 'reply_all');
  expect(renderReplyRecipients(t)).toContain('aria-expanded="true"');
  expect(replyRecipientPayload(t).cc).toEqual(['colleague@example.test']);
  expect(replyRecipientPayload(t).to).toEqual(['customer@example.test']);
  changeReplyMode(t, 'reply');
  expect(replyRecipientPayload(t).cc).toEqual([]);
  expect(renderReplyRecipients(t)).toContain('id="reply-cc-field-TK-1" hidden');
});

test('stale recipients and unavailable senders remain visible and addresses stay escaped', () => {
  const t = replyTicket();
  savedRecipients = { ...replyDraft(t), source_message_id: 'earlier', to: ['<old@example.test>'],
    cc: '"<cc@example.test>', sending_channel_id: 'removed', sending_address: 'old@example.test' };
  const html = renderReplyRecipients(t);
  expect(html).toContain('This draft uses earlier recipients.');
  expect(html).toContain('data-action="td.refreshRecipients"');
  expect(html).toContain('Previously selected inbox unavailable');
  expect(html).toContain('&lt;old@example.test&gt;');
  expect(html).toContain('value="&quot;&lt;cc@example.test&gt;"');
});

test('Cc toggle focuses the input and never hides populated recipients', () => {
  const source = readFileSync(new URL('../web/js/tickets/detail.js', import.meta.url), 'utf8');
  const action = source.match(/'td.toggleReplyCc': (\(ds, el\) => \{[\s\S]*?\n  \}),/)[1];
  let focused = 0, expanded;
  const field = { hidden: true }, input = { value: '', focus: () => { focused++; } };
  const toggle = runInNewContext('(' + action + ')', {
    document: { getElementById: id => id === 'reply-cc-field-TK-1' ? field : input },
  });
  const button = { setAttribute: (_key, value) => { expanded = value; } };
  toggle({ ticketId: 'TK-1' }, button);
  expect(field.hidden).toBe(false); expect(expanded).toBe('true'); expect(focused).toBe(1);
  input.value = 'keep@example.test'; toggle({ ticketId: 'TK-1' }, button);
  expect(field.hidden).toBe(false); expect(expanded).toBe('true');
  input.value = ''; toggle({ ticketId: 'TK-1' }, button);
  expect(field.hidden).toBe(true); expect(expanded).toBe('false');
});
