import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const detail = read('../web/js/tickets/detail.js');
const wizard = read('../web/js/tickets/new-ticket.js');
const categories = ['open', 'pending', 'escalated', 'gdpr', 'resolved', 'closed'];
const actions = read('../web/js/tickets/send-actions.js').replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');

test('shared send choices keep the agreed order, custom statuses, active choices and permission checks', () => {
  const rows = ['open', 'resolved', 'closed', 'pending', 'escalated', 'gdpr', 'custom-review', 'custom-closed'].map(key => ({ key, label: key, base_key: key === 'custom-closed' ? 'closed' : 'pending' }));
  const labels = runInNewContext(actions + 'sendActions().map(a => a.label)', { STATUS_CATEGORIES: categories, can: () => true, statusOptions: () => rows });
  expect(Array.from(labels)).toEqual(['Send', 'Send & resolve', 'Send & close', 'Send & pending', 'Send & escalate', 'Send & custom-review']);
  const restricted = runInNewContext(actions + 'sendActions()', { STATUS_CATEGORIES: categories, can: () => false, statusOptions: () => rows });
  expect(restricted).toHaveLength(1);
  const inactive = runInNewContext(actions + 'sendActions()', { STATUS_CATEGORIES: categories, can: () => true, statusOptions: () => rows.filter(r => r.key !== 'resolved') });
  expect(Array.from(inactive, a => a.status)).not.toContain('resolved');
});

test('new ticket changes each selected status only after confirmed sending and validates grants and reasons first', async () => {
  const functions = wizard.slice(wizard.indexOf('async function confirmSend('), wizard.indexOf('async function createOnServer('));
  for (const status of ['', 'resolved', 'pending', 'escalated', 'custom-review']) {
    for (const outcome of ['sent', 'unconfirmed', 'denied', 'reason-missing']) {
      let creates = 0, updates = [];
      const ticket = { id: 'TK-NEW', _uuid: 'ticket', status: 'open' };
      const context = {
        NT: { busy: false, statusAfterSend: status, closeReason: '', files: [], customer: { uuid: 'customer' } },
        TICKETS: [ticket], CURRENT_TICKET: 'TK-NEW', can: key => outcome !== 'denied' || ['tickets.create','tickets.reply'].includes(key),
        currentWorkspace:()=>true,harvestWorkspace(){},validateStep1:()=>true,catOptions:()=>[],recipientPayload:()=>({to:['synthetic@example.test']}),unresolvedVariables:()=>[],closeWorkspace(){},
        document: { getElementById: id => ({ value: id === 'nt2-msg' ? 'Hello' : '', checkValidity:()=>true,focus() {} }) },
        required: () => false, alert() {}, setBusy() {}, showToast() {},
        getWorkspaceId: () => 'workspace', getJwt: () => 'session', isSessionApiBacked: () => true,
        loadStatusOptions: async () => {}, statusOptionsState: () => ({ ready: true }),
        statusChoice: () => ({ is_active: true, reason_required: outcome === 'reason-missing', reasons: [] }),
        prepareCustomerReply: async () => ({ translation: 'Hello', replyLanguage: 'English' }),
        createOnServer: async () => { creates++; return { displayId: ticket.id, emailed: outcome === 'sent' }; },
        applySentStatus: async (...args) => updates.push(args),
        closeModal() {}, resetNT() {}, updateNavBadges() {}, openTicket() {}, console: { error() {} },
      };
      await runInNewContext(functions + 'confirmSend()', context);
      expect(creates).toBe(status && ['denied', 'reason-missing'].includes(outcome) ? 0 : 1);
      expect(updates.length).toBe(status && outcome === 'sent' ? 1 : 0);
      if (updates.length) expect(updates[0]).toEqual(['TK-NEW', status, null]);
      expect(ticket.status).toBe('open');
    }
  }
});

test('post-send retry changes status only and ignores stale sessions and repeated clicks', async () => {
  const helper = detail.slice(detail.indexOf('async function applySentStatus('), detail.indexOf('function showSentTextModal('));
  for (const scenario of ['retry', 'switched', 'ticket-changed']) {
    let workspace = 'workspace', current = 'T1', attempts = 0, confirm, closed = 0;
    const context = {
      getWorkspaceId: () => workspace, getJwt: () => 'session', get CURRENT_TICKET() { return current; },
      changeTicketStatus: async () => { attempts++; return attempts > 1; },
      showModal: (_title, _body, callback, label) => { expect(label).toBe('Retry status only'); confirm = callback; },
      closeModal: () => { closed++; },
      document: { querySelector: () => ({ disabled: false }), getElementById: () => ({ textContent: '' }) },
      sendCompose: () => { throw Error('Must never resend'); },
    };
    await runInNewContext(helper + "applySentStatus('T1', 'resolved', null)", context);
    expect(attempts).toBe(1);
    if (scenario === 'switched') workspace = 'other';
    if (scenario === 'ticket-changed') current = 'T2';
    await Promise.all([confirm(), confirm()]);
    expect(attempts).toBe(scenario === 'retry' ? 2 : 1);
    expect(closed).toBe(scenario === 'retry' ? 1 : 0);
  }
});

test('combined reply actions require confirmed delivery before changing status', async () => {
  const handler = detail.slice(detail.indexOf('async function sendComposeAnd('), detail.indexOf('// Retry only'));
  for (const status of ['resolved', 'pending', 'escalated', 'custom-review']) {
    let sends = 0;
    await runInNewContext(handler + `sendComposeAnd('T1', '${status}')`, {
      CURRENT_TICKET: 'T1', COMPOSE_TAB: 'reply', hideSendMenu() {},
      getWorkspaceId: () => 'workspace', getJwt: () => 'session',
      loadStatusOptions: async () => {}, statusOptionsState: () => ({ ready: true }),
      statusChoice: () => ({ is_active: true }), chooseStatusReason: async () => null,
      sendCompose: async (_id, _withoutAI, options) => { sends++; expect(options.requireEmail).toBe(true); return false; },
      applySentStatus: () => { throw Error('Unconfirmed delivery must not update status'); },
      changeTicketStatus: () => { throw Error('Unconfirmed delivery must not update status'); },
    });
    expect(sends).toBe(1);
  }
});
