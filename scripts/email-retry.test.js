import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/tickets/email-retry.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('const pending'), source.indexOf('registerActions({')).replace('export async', 'async');

test('retry updates the existing message, ignores double clicks and stale sessions, and restores failed controls', async () => {
  for (const scenario of ['sent', 'failed', 'switched', 'double-click']) {
    const message = { _uuid: 'original', email: { status: 'saved' } };
    const ticket = { id: 'T1', _uuid: 'ticket', msgs: [message] };
    const button = { isConnected: true, disabled: false, textContent: 'Retry sending' };
    let workspace = 'one', calls = 0, opens = 0;
    const context = {
      TICKETS: [ticket], CURRENT_TICKET: 'T1', getWorkspaceId: () => workspace, getJwt: () => 'session',
      apiPost: async (path, body) => {
        calls++; expect(path).toBe('/api/v1/tickets/ticket/messages/original/retry'); expect(Object.keys(body)).toHaveLength(0);
        if (scenario === 'failed') throw Error('Offline');
        if (scenario === 'switched') workspace = 'two';
        return { email_metadata: { status: 'sent' }, delivery: { emailed: true } };
      },
      openTicket: () => { opens++; }, notifyReplyDelivery() {}, showToast() {}, button,
    };
    await runInNewContext(handler + (scenario === 'double-click' ? 'Promise.all([retryEmail("original",button),retryEmail("original",button)])' : 'retryEmail("original",button)'), context);
    expect(calls).toBe(1); expect(ticket.msgs).toHaveLength(1); expect(ticket.msgs[0]).toBe(message);
    expect(message.email.status).toBe(['failed', 'switched'].includes(scenario) ? 'saved' : 'sent');
    expect(opens).toBe(['failed', 'switched'].includes(scenario) ? 0 : 1);
    expect(button.disabled).toBe(false); expect(button.textContent).toBe('Retry sending');
  }
});
