import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import './bridge-smoke-shim-prefix.js';

const { captureTicketLayout, setComposerMode } = await import('../web/js/tickets/layout.js');
test('expand and restore preserve the editor, reading position and details preference', () => {
  const editor = { value: 'Unsent reply', focus() {} };
  const thread = { scrollTop: 123 };
  const root = { dataset: { composeMode: 'edit', details: 'show' },
    querySelector: selector => selector === '.thread' ? thread : selector === '.ql-editor, textarea.compose-area' ? editor : null,
    querySelectorAll: () => [],
  };
  document.getElementById = () => root;
  setComposerMode('test', 'expanded', true);
  expect(root.dataset.details).toBe('hide');
  expect(captureTicketLayout('test').detailsBeforeExpand).toBe('show');
  setComposerMode('test', 'expanded');
  setComposerMode('test', 'edit', true);
  expect(root.dataset.details).toBe('show');
  expect(editor.value).toBe('Unsent reply');
  expect(thread.scrollTop).toBe(123);
  root.dataset.details = 'hide';
  setComposerMode('test', 'expanded');
  setComposerMode('test', 'read', true);
  expect(root.dataset.details).toBe('hide');
});

test('sending closes replies, including expanded and send-and-resolve, but failures keep the draft', async () => {
  const source = readFileSync(new URL('../web/js/tickets/detail.js', import.meta.url), 'utf8');
  const sendFunctions = source.slice(source.indexOf('async function sendComposeAnd('), source.indexOf('// Map the server\'s agent-reply delivery'));
  for (const scenario of ['send', 'expanded', 'resolve', 'failed', 'note']) {
    let text = 'Thank you.', focused = false, status = null;
    const ticket = { id: 'test', _uuid: 'ticket', replyRecipients: {}, msgs: [] };
    const launcher = { focus() { focused = true; }, setAttribute() {} };
    const root = {
      dataset: scenario === 'expanded'
        ? { composeMode: 'expanded', details: 'hide', detailsBeforeExpand: 'show' }
        : { composeMode: 'edit', details: 'show' },
      querySelector: selector => selector === '[data-compose-launch]' ? launcher : null,
      querySelectorAll: () => [launcher],
    };
    document.getElementById = id => id === 'ticket-page-test' ? root : null;
    const context = {
      document: { getElementById: id => id === 'compose-test' ? {} : null },
      window: { confirm: () => true }, CURRENT_TICKET: 'test', COMPOSE_TAB: scenario === 'note' ? 'note' : 'reply',
      TICKETS: [ticket], CUSTOMERS: [], setComposerMode,
      getPlainText: () => text, getHtml: () => null, isComposerEmpty: () => !text,
      getWorkspaceId: () => 'workspace', getJwt: () => 'session', replyRecipientPayload: () => ({}),
      latestCustomerText: () => ({ text: 'Hello' }), confirmIfOthersComposing: async () => true,
      setAiThinking() {}, prepareCustomerReply: async () => ({ translation: text }),
      replyWarnings: () => [], loadMessageReview: () => null, confirmedReplySuggestion: () => null,
      pendingAttachmentIds: () => [], renderPendingAttachments() {}, attachmentsUploading:()=>false, parseMentions: () => [],
      apiPost: async () => {
        if (scenario === 'failed') throw new Error('Offline');
        return { message: { id: 'message', created_at: '2026-09-30T12:00:00Z', body: text } };
      },
      clearComposer() { text = ''; }, clearDraft() {}, onComposeInput() {},
      prepareDraftSend: async () => ({ version: 1 }), finishDraftSend: () => true, refreshPersonalDraft: async () => {},
      openTicket() {}, invalidateAgentReport() {}, hideSendMenu() {}, alert() {},
      changeTicketStatus: async (_id, value) => { status = value; },
    };
    await runInNewContext(sendFunctions + (scenario === 'resolve'
      ? "sendComposeAnd('test', 'resolved')" : "sendCompose('test')"), context);
    const closed = !['failed', 'note'].includes(scenario);
    expect(root.dataset.composeMode).toBe(closed ? 'read' : 'edit');
    expect(root.dataset.details).toBe('show');
    expect(focused).toBe(closed);
    expect(text).toBe(scenario === 'failed' ? 'Thank you.' : '');
    expect(ticket.msgs.length).toBe(scenario === 'failed' ? 0 : 1);
    expect(status).toBe(scenario === 'resolve' ? 'resolved' : null);
  }
});
