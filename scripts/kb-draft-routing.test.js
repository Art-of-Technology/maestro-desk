import { test, expect, mock } from 'bun:test';

const requests = [];
let lookups = 0;
globalThis.document = {
  getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }),
};
mock.module('../web/js/core/data.js', () => ({
  TICKETS: [{ id: 'TK-test', subject: 'Withdrawal timing', msgs: [] }],
}));
mock.module('../web/js/core/state.js', () => ({ AI_THINKING: false, setAiThinking() {} }));
mock.module('../web/js/ai/client.js', () => ({
  callClaude: async (input) => {
    requests.push(input);
    return { text: 'Test draft' };
  },
}));
mock.module('../web/js/tickets/detail.js', () => ({ onComposeInput() {} }));
mock.module('../web/js/tickets/composer.js', () => ({
  focusEnd() {},
  getPlainText: () => '',
  setText() {},
}));
mock.module('../web/js/kb-integration/index.js', () => ({
  buildKbQuery: () => 'withdrawal',
  fetchKbArticles: async () => {
    lookups++;
    return { articles: [{ title: 'External policy', body: 'External withdrawal rule' }] };
  },
}));
const { aiAction } = await import('../web/js/ai/reply.js');

test('normal drafts use published knowledge while external KB replies preserve their source', async () => {
  await aiAction('TK-test', 'draft');
  expect(requests[0].action).toBe('kb_draft');
  expect(lookups).toBe(0);
  await aiAction('TK-test', 'kb-reply');
  expect(requests[1].action).toBe('draft');
  expect(lookups).toBe(1);
  expect(requests[1].messages[0].content).toContain('External withdrawal rule');
});
