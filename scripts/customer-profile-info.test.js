import { expect, test, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
mock.module('../web/js/tickets/drafts.js', () => ({ loadDraftRecipients: () => null, saveDraftRecipients() {} }));
const { renderCustomerEmailNames } = await import('../web/js/customers/email-names.js');

globalThis.window ||= globalThis;
window.escHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

test('profile groups owned sender names and escapes them without inferring ownership', () => {
  const c = { id: 'c', first: 'Jane', last: 'Doe', maestroUserId: 'p', email: 'a@example.test' };
  const m = { r: 'customer', from: '<Alias>', t: 'Hello', email: { status: 'received', from: c.email } };
  const tickets = [{ customerId: 'c', msgs: [m, m, { ...m, from: 'Third party', email: { ...m.email, from: 'other@example.test' } }, { ...m, from: 'Forwarded', forwarded: true }] }];
  const html = renderCustomerEmailNames(c, tickets);
  expect(html.match(/&lt;Alias&gt;/g)).toHaveLength(1);
  expect(html).toContain('Name differs from player account');
  expect(html).toContain('loaded conversations');
  expect(html).not.toContain('Third party');
  expect(html).not.toContain('Forwarded');
  expect(renderCustomerEmailNames({ ...c, erased: true }, tickets)).toBe('');
  expect(renderCustomerEmailNames(c, [])).toContain('No email sender names');
});

function fixture(translateText) {
  const source = readFileSync(new URL('../web/js/customers/activity-translation.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export async function', 'async function');
  const text = { textContent: 'Bonjour' }, status = { textContent: '' };
  const row = { isConnected: true, querySelector: selector => selector.includes('text') ? text : status };
  const button = { disabled: false, textContent: 'Translate', closest: () => row };
  const message = { t: 'Bonjour' };
  const ctx = { TICKETS: [{ id: 't', msgs: [message] }], AGENT_PREFERRED_LANG: 'English', translationScope: () => 'scope', messageTranslationRequest: () => async () => ({ text: 'Hello' }), registerActions() {}, translateText };
  runInNewContext(source, ctx);
  return { ctx, row, button, text, status, message, run: () => ctx.translateActivity({ ticketId: 't', messageIndex: '0' }, button) };
}

test('activity translates safely and restores the untouched original', async () => {
  const f = fixture(async () => ({ translation: '<Hello>' }));
  await f.run();
  expect(f.text.textContent).toBe('<Hello>');
  expect(f.status.textContent).toContain('English');
  expect(f.message.t).toBe('Bonjour');
  await f.run();
  expect(f.text.textContent).toBe('Bonjour');
  expect(f.button.textContent).toBe('Translate');
});

test('activity handles failures and ignores results after navigation or scope changes', async () => {
  const failure = fixture(async () => ({ error: 'No AI credits' }));
  await failure.run();
  expect(failure.status.textContent).toBe('No AI credits');
  expect(failure.button.disabled).toBe(false);
  expect(failure.text.textContent).toBe('Bonjour');
  for (const invalidate of [f => f.row.isConnected = false, f => f.ctx.translationScope = () => 'other', f => f.message.t = 'Edited']) {
    let finish;
    const f = fixture(() => new Promise(resolve => finish = resolve));
    const pending = f.run();
    expect(f.button.disabled).toBe(true);
    invalidate(f);
    finish({ translation: 'Hello' });
    await pending;
    expect(f.text.textContent).toBe('Bonjour');
    if (f.row.isConnected) expect(f.status.textContent).toBe('');
  }
});

test('server preview translation keys stay stable when list positions change', async () => {
  const f = fixture(async () => ({ translation: 'Hello' }));
  const keys = [];
  f.ctx.TICKETS = [];
  f.ctx.messageTranslationRequest = key => { keys.push(JSON.stringify(key)); return async () => ({ text: 'Hello' }); };
  const entry = { ticket: { _uuid: 'server-ticket' }, message: { t: 'Bonjour' }, created_at: '2026-11-16T10:00:00Z', role: 'customer', author_label: 'Sender' };
  await f.ctx.translateActivity({ messageIndex: '0' }, f.button, entry);
  expect(f.text.textContent).toBe('Hello');
  await f.ctx.translateActivity({ messageIndex: '0' }, f.button, entry);
  expect(f.text.textContent).toBe('Bonjour');
  await f.ctx.translateActivity({ messageIndex: '4' }, f.button, entry);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).toContain('profile-preview');
});
