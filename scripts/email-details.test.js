import { test, expect, mock } from 'bun:test';

mock.module('../web/js/tickets/drafts.js', () => ({ loadDraftRecipients() {}, saveDraftRecipients() {} }));
const { renderEmailDetails, renderEmailRetry, messageTime } = await import('../web/js/tickets/email-details.js');

globalThis.window ||= globalThis;
window.escHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
window.escAttr = window.escHtml;

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
