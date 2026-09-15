import { test, expect, mock } from 'bun:test';
let workspace = 'one';
const session = { userId: 'agent-one' };
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k), key: i => [...storage.keys()][i], get length() { return storage.size; } };
globalThis.window = { escHtml: s => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;'), escAttr: String };
mock.module('../web/js/core/state.js', () => ({ COMPOSE_TAB: 'reply', SESSION: session }));
mock.module('../web/js/core/api-client.js', () => ({ getWorkspaceId: () => workspace }));
const { loadDraft, saveDraft, loadDraftReview, saveDraftReview, clearDraft } = await import('../web/js/tickets/drafts.js');
const { renderReplyReview } = await import('../web/js/ai/reply-review.js');

test('internal metadata is separate, scoped, escaped and cleared after sending', () => {
  const review = { references: [{ id: 'KB-1', title: '<script>bad</script>', url: 'javascript:alert(1)' }], notes: ['Internal only'] };
  saveDraft('T1', '<p>Customer reply</p>');
  saveDraftReview('T1', review);
  expect(loadDraft('T1')).toBe('<p>Customer reply</p>');
  expect(loadDraftReview('T1')).toEqual(review);
  expect(loadDraftReview('T1', 'note')).toBeNull();
  const output = renderReplyReview('T1');
  expect(output).toContain('Internal references — not sent');
  expect(output).not.toContain('<script>');
  expect(output).not.toContain('javascript:');
  workspace = 'two'; expect(loadDraftReview('T1')).toBeNull();
  workspace = 'one'; session.userId = 'agent-two'; expect(loadDraftReview('T1')).toBeNull();
  session.userId = 'agent-one'; clearDraft('T1');
  expect(loadDraftReview('T1')).toBeNull();
  expect(loadDraft('T1')).toBe('');
});
