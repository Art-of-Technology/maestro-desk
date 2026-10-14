import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const detail = readFileSync(new URL('../web/js/tickets/detail.js', import.meta.url), 'utf8');
const send = detail.slice(detail.indexOf('async function sendComposeAnd('), detail.indexOf('// Map the server'));

test('manual replies preserve checks, rich content and attachments without AI', async () => {
  for (const scenario of ['sent', 'cancelled', 'failed', 'switched', 'edited', 'double-click', 'missing-recipient', 'uploading']) {
    let text = 'Hello', workspace = 'one', posted = [], cleared = false, prompts = [];
    const ticket = { id: 'T1', _uuid: 'ticket', replyRecipients: {}, msgs: [], autoTranslateReplies: true };
    const context = {
      TICKETS: [ticket], CUSTOMERS: [], CURRENT_TICKET: 'T1', COMPOSE_TAB: 'reply',
      document: { getElementById: id => id === 'compose-T1' ? {} : null },
      window: { confirm: message => { prompts.push(message); return scenario !== 'cancelled'; } },
      getPlainText: () => text, getHtml: () => '<p><strong>Hello</strong></p>', isComposerEmpty: () => false,
      getWorkspaceId: () => workspace, getJwt: () => 'session', latestCustomerText: () => ({ text: 'Customer question' }),
      attachmentsUploading: () => scenario === 'uploading', pendingAttachmentIds: () => ['attachment'],
      replyRecipientPayload: () => ({ to: scenario === 'missing-recipient' ? [] : ['customer@example.test'], cc: [] }),
      confirmIfOthersComposing: async () => {
        if (scenario === 'switched') workspace = 'two';
        if (scenario === 'edited') text = 'Changed draft';
        return true;
      },
      prepareCustomerReply: () => { throw Error('Manual send must not use AI'); },
      replyWarnings: () => [], loadMessageReview: () => null, confirmedReplySuggestion: () => null,
      onComposeInput() {}, prepareDraftSend: async () => ({ version: 5 }), finishDraftSend: () => true,
      refreshPersonalDraft: async () => {},
      apiPost: async (_path, body) => {
        posted.push(body);
        if (scenario === 'failed') throw Error('Unavailable');
        return { message: { id: 'sent', body: body.body, body_html: body.body_html, created_at: '2026-10-06T12:00:00Z' }, draft_version: 6 };
      },
      clearComposer: () => { cleared = true; }, renderPendingAttachments() {}, openTicket() {},
      setComposerMode() {}, invalidateAgentReport() {}, showToast() {}, alert() {},
    };
    await runInNewContext(send + (scenario === 'double-click'
      ? "Promise.all([sendCompose('T1',true),sendCompose('T1',true)])" : "sendCompose('T1',true)"), context);
    const attempted = ['sent', 'failed', 'double-click'].includes(scenario);
    expect(posted.length).toBe(attempted ? 1 : 0);
    expect(cleared).toBe(['sent', 'double-click'].includes(scenario));
    expect(ticket.autoTranslateReplies).toBe(true);
    if (attempted) {
      expect(prompts[0]).toContain('header, signature and footer');
      expect(posted[0]).toMatchObject({ body: 'Hello', body_html: '<p><strong>Hello</strong></p>', attachment_ids: ['attachment'], draft_version: 5 });
      expect(posted[0].reply_language).toBeUndefined();
    }
  }
});

test('new-ticket manual sends require confirmation and omit translation while keeping failed drafts', async () => {
  const source = readFileSync(new URL('../web/js/tickets/new-ticket.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('async function confirmSend('), source.indexOf('async function createOnServer('));
  for (const scenario of ['sent', 'cancelled', 'failed', 'normal']) {
    const state = { busy: false, replyLanguage: 'Spanish' };
    let posted = [], closed = false, aiCalls = 0, notices = [];
    const context = {
      NT: state, document: { getElementById: () => ({ value: 'Hello' }) },
      window: { confirm: message => { expect(message).toContain('will not be translated'); return scenario !== 'cancelled'; } },
      required: () => false, setBusy: value => { state.busy = value; },
      isSessionApiBacked: () => true, getWorkspaceId: () => 'one', getJwt: () => 'session',
      prepareCustomerReply: async () => { aiCalls++; throw Error('AI unavailable'); },
      createOnServer: async (snapshot, args) => {
        posted.push({ snapshot, args });
        if (scenario === 'failed') throw Error('Unavailable');
        return { displayId: 'T1', keptDraft: false };
      },
      closeModal: () => { closed = true; }, resetNT() {}, updateNavBadges() {}, openTicket() {},
      console: { error() {} }, showToast: message => notices.push(message),
    };
    await runInNewContext(functions + `confirmSend(${scenario !== 'normal'})`, context);
    expect(aiCalls).toBe(scenario === 'normal' ? 1 : 0);
    expect(closed).toBe(scenario === 'sent');
    expect(posted.length).toBe(['sent', 'failed'].includes(scenario) ? 1 : 0);
    if (posted.length) {
      expect(posted[0].snapshot.replyLanguage).toBe('');
      expect(posted[0].args).toEqual({ message: 'Hello', send: true });
    }
    if (['normal', 'failed'].includes(scenario)) { expect(state.busy).toBe(false); expect(notices.length).toBe(1); }
  }
});

test('AI settings distinguish free checks from generation, reject unverified success and ignore stale results', async () => {
  const source = readFileSync(new URL('../web/js/settings/index.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('async function testAIConnection('), source.indexOf('async function setAIEnrichment('));
  for (const scenario of ['free', 'paid', 'cancelled', 'unverified', 'switched', 'failed', 'double-click']) {
    let calls = 0, workspace = 'one';
    const node = { dataset: {}, isConnected: true, textContent: '' };
    const context = {
      document: { getElementById: () => node }, window: { confirm: () => scenario !== 'cancelled' },
      getWorkspaceId: () => workspace, getJwt: () => 'session', AI_MODEL: 'test-model', refreshAIStatus() {},
      checkAIConnection: async () => { calls++; return { connected: true }; },
      checkAIGeneration: async () => {
        calls++;
        if (scenario === 'switched') workspace = 'two';
        if (scenario === 'failed') throw Error('Not enough workspace credit');
        return scenario === 'unverified' ? {} : { generation_verified: true };
      },
    };
    await runInNewContext(fn + (scenario === 'double-click' ? 'Promise.all([testAIConnection(true),testAIConnection(true)])' : `testAIConnection(${scenario !== 'free'})`), context);
    expect(calls).toBe(scenario === 'cancelled' ? 0 : 1);
    expect(node.dataset.checking).toBeUndefined();
    if (scenario === 'free') expect(node.textContent).toContain('have not been tested');
    if (['paid', 'double-click'].includes(scenario)) expect(node.textContent).toContain('generated a test response successfully');
    if (scenario === 'unverified') expect(node.textContent).toContain('not verified');
    if (scenario === 'switched') expect(node.textContent).not.toContain('successfully');
    if (scenario === 'failed') expect(node.textContent).toBe('Not enough workspace credit');
  }
});
