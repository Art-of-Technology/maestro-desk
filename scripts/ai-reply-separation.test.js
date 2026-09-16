import { test, expect, mock } from 'bun:test';
let workspace = 'one', text = 'Existing reply', html = '<p>Existing reply</p>', review, lastRequest, thinking = false;
let result, fail, lookupError, release;
const editor = { isConnected: true };
globalThis.document = { getElementById: id => id === 'compose-T1' ? editor : null };
mock.module('../web/js/core/data.js', () => ({ TICKETS: [{ id: 'T1', subject: 'Help', msgs: [] }] }));
mock.module('../web/js/core/state.js', () => ({ AI_THINKING: false, COMPOSE_TAB: 'reply', setAiThinking: value => { thinking = value; } }));
mock.module('../web/js/core/api-client.js', () => ({ getJwt: () => 'session', getWorkspaceId: () => workspace }));
mock.module('../web/js/tickets/detail.js', () => ({ onComposeInput() {} }));
mock.module('../web/js/ai/translate.js', () => ({ ensureCustomerLanguage: async () => 'Spanish', latestCustomerText: () => ({text:'Hola'}), AGENT_PREFERRED_LANG: 'English' }));
mock.module('../web/js/tickets/composer.js', () => ({ focusEnd() {}, getPlainText: () => text, getHtml: () => html, setText: (_id, value) => { text = value; html = null; } }));
mock.module('../web/js/tickets/drafts.js', () => ({ loadDraftReview: () => null }));
mock.module('../web/js/ai/reply-review.js', () => ({ showReplyReview: (_id, value) => { review = value; } }));
mock.module('../web/js/kb-integration/index.js', () => ({ buildKbQuery: () => 'help', fetchKbArticles: async () => ({ error: lookupError, articles: [] }) }));
mock.module('../web/js/ai/client.js', () => ({ callClaude: async args => {
  lastRequest = args;
  if (release) await new Promise(resolve => { release = resolve; });
  if (fail) throw new Error('Generation failed');
  return result;
} }));
const { aiAction } = await import('../web/js/ai/reply.js');

test('only customer text enters the composer; internal references remain separate', async () => {
  result = { text: 'Here is your game: https://example.com/game', data: { internal: { references: [{ id: 'KB-1', title: 'Game source' }], notes: ['Check jurisdiction.'] } } };
  await aiAction('T1', 'draft');
  expect(text).toBe(result.text);
  expect(text).not.toContain('KB-1');
  expect(review).toEqual(result.data.internal);
  expect(lastRequest.replyFormat).toBe(true);
  expect(lastRequest.replyLanguage).toBe('Spanish');
  expect(thinking).toBe(false);
});

test('lookup failures, generation errors and malformed results preserve an existing reply', async () => {
  const before = text;
  lookupError = 'No connection';
  await aiAction('T1', 'kb-reply');
  expect(text).toBe(before);
  expect(review.notes[0]).toContain('Source lookup failed');
  expect(thinking).toBe(false);
  lookupError = null; fail = true;
  await aiAction('T1', 'draft');
  expect(text).toBe(before);
  expect(review.notes).toContain('Generation failed');
  fail = false; result = { text: 'Draft: raw fallback' };
  await aiAction('T1', 'draft');
  expect(text).toBe(before);
  expect(review.notes[0]).toContain('incomplete');
});

test('internal-only results leave customer text untouched', async () => {
  const before = text;
  result = { text: '', data: { internal: { references: [], notes: ['Sources conflict.'] } } };
  await aiAction('T1', 'draft');
  expect(text).toBe(before);
  expect(review.notes).toContain('Sources conflict.');
});

test('late results cannot overwrite edits or cross workspace boundaries', async () => {
  result = { text: 'Late result', data: { internal: { references: [], notes: [] } } };
  release = true;
  const edited = aiAction('T1', 'draft');
  await Promise.resolve();
  text = 'Agent edit'; release(); await edited;
  expect(text).toBe('Agent edit');
  expect(review.notes[0]).toContain('edited the reply');
  release = true;
  const switched = aiAction('T1', 'draft');
  await Promise.resolve();
  workspace = 'two'; const prior = review;
  release(); await switched; release = null;
  expect(text).toBe('Agent edit');
  expect(review).toBe(prior);
  expect(thinking).toBe(false);
});
