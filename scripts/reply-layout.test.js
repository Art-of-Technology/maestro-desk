import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import './bridge-smoke-shim-prefix.js';

const { captureTicketLayout, setComposerMode } = await import('../web/js/tickets/layout.js');

function replyTools(tab = 'reply', admin = true, live = true) {
  const source = readFileSync(new URL('../web/js/tickets/detail.js', import.meta.url), 'utf8');
  const markup = source.slice(source.indexOf('<div class="composer-actions"'), source.indexOf('<div class="composer-send-actions">'));
  return runInNewContext('`' + markup + '`', {
    id: 'TK-1', t: { _uuid: live ? 'ticket-uuid' : null, attachments: [] }, COMPOSE_TAB: tab,
    window: { escAttr: value => value, isAdmin: () => admin },
  });
}

test('composer exposes the former Tools actions directly with accessible icon labels', () => {
  const html = replyTools();
  expect(html).not.toContain('<details');
  const buttons = [...html.matchAll(/<button\b([^>]*composer-tool[^>]*)>/g)].map(match => match[1]);
  expect(buttons).toHaveLength(7);
  for (const button of buttons) {
    expect(button).toContain('type="button"');
    expect(button).toContain('data-ticket-id="TK-1"');
    const label = button.match(/aria-label="([^"]+)"/)[1];
    const title = label === 'Insert template' ? `${label} (Ctrl/Cmd+Shift+Space)` : label;
    expect(button).toContain(`title="${title}"`);
    if (label === 'Insert template') expect(button).toContain('aria-keyshortcuts="Control+Shift+Space Meta+Shift+Space"');
  }
  expect(html).toContain('data-action="td.macroPanel"');
  expect(html).toContain('data-verb="similar"');
  for (const token of ['name', 'ticket', 'brand', 'agent']) expect(html).toContain(`data-token="{${token}}"`);
});

test('composer icons preserve reply, note, demo and admin visibility rules', () => {
  expect(replyTools('reply', false)).toContain('data-verb="similar"');
  expect(replyTools('reply', false)).not.toContain('data-action="td.saveTemplate"');
  for (const html of [replyTools('note'), replyTools('reply', true, false)]) {
    expect(html).not.toContain('data-verb="similar"');
    expect(html).not.toContain('data-action="td.saveTemplate"');
    expect(html).toContain('data-action="td.macroPanel"');
    expect(html).toContain('data-token="{name}"');
  }
});
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
      getWorkspaceId: () => 'workspace', getJwt: () => 'session',
    loadStatusOptions: async () => {}, statusOptionsState: () => ({ ready: true }), statusChoice: () => ({ is_active: true }), replyRecipientPayload: () => ({ to: ['customer@example.test'], cc: [] }),
      latestCustomerText: () => ({ text: 'Hello' }), confirmIfOthersComposing: async () => true,
      setAiThinking() {}, prepareCustomerReply: async () => ({ translation: text }),
      replyWarnings: () => [], loadMessageReview: () => null, confirmedReplySuggestion: () => null,
      pendingAttachmentIds: () => [], renderPendingAttachments() {}, attachmentsUploading:()=>false, parseMentions: () => [],
      apiPost: async () => {
        if (scenario === 'failed') throw new Error('Offline');
        return { message: { id: 'message', created_at: '2026-09-30T12:00:00Z', body: text }, delivery: { emailed: true } };
      },
      clearComposer() { text = ''; }, clearDraft() {}, onComposeInput() {},
      prepareDraftSend: async () => ({ version: 1 }), finishDraftSend: () => true, refreshPersonalDraft: async () => {},
      openTicket() {}, invalidateAgentReport() {}, hideSendMenu() {}, notifyReplyDelivery() {}, alert() {},
      changeTicketStatus: async (_id, value) => { status = value; },
      chooseStatusReason: async () => null,
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
