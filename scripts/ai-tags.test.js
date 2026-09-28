import { beforeEach, expect, mock, test } from 'bun:test';
globalThis.localStorage = { getItem: () => null };
const { setCurrentTicket } = await import('../web/js/core/state.js');
const tickets = [];
let workspace, jwt, current, request, panel;
mock.module('../web/js/core/data.js', () => ({ TICKETS: tickets }));
mock.module('../web/js/core/api-client.js', () => ({ apiPost: (...args) => request(...args), getWorkspaceId: () => workspace, getJwt: () => jwt }));
const { generateAITags, renderAITags } = await import('../web/js/ai/tags.js');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
globalThis.window = { escHtml: escape, escAttr: escape };
globalThis.document = { getElementById: () => panel };
beforeEach(() => {
  workspace = 'workspace'; jwt = 'session'; current = 'TK-23';
  setCurrentTicket(current);
  panel = { dataset: { ticketId: current }, innerHTML: '' };
  tickets.splice(0, tickets.length, { id: current, _uuid: 'uuid', aiTags: [{ tag: 'existing', conf: 80, accepted: true }], aiDraft: { text: 'Keep this draft' } });
  request = mock(async () => ({ ai_tags: [{ tag: 'withdrawal', confidence: 95, accepted: false }] }));
});
test('shows an empty state, generates suggestions and preserves drafts', async () => {
  expect(renderAITags(tickets[0])).toContain('Generate tags');
  expect(renderAITags(tickets[0])).toContain('No tag suggestions yet.');
  await generateAITags(current);
  expect(request).toHaveBeenCalledWith('/api/v1/tickets/uuid/triage/tags', {});
  expect(tickets[0].aiTags[0].tag).toBe('withdrawal');
  expect(tickets[0].aiDraft.text).toBe('Keep this draft');
  expect(panel.innerHTML).toContain('Accept tag withdrawal');
});
test('blocks repeat clicks while pending and keeps existing tags on a credit failure', async () => {
  let reject;
  request = mock(() => new Promise((_, r) => { reject = r; }));
  const task = generateAITags(current);
  await generateAITags(current);
  expect(request).toHaveBeenCalledTimes(1);
  expect(panel.innerHTML).toContain('Generating tags…');
  reject({ status: 402 }); await task;
  expect(panel.innerHTML).toContain('no AI credit');
  expect(panel.innerHTML).toContain('Retry');
  expect(tickets[0].aiTags[0].accepted).toBe(true);
  request = mock(async () => ({ ai_tags: [] }));
  await generateAITags(current);
  expect(panel.innerHTML).toContain('No new tags to suggest.');
});
test('does not redraw another ticket or apply results to a changed session or workspace', async () => {
  for (const change of [() => { current = 'TK-24'; setCurrentTicket(current); panel.dataset.ticketId = current; }, () => { workspace = 'other'; }, () => { jwt = 'other'; }]) {
    workspace = 'workspace'; jwt = 'session'; current = 'TK-23'; panel.dataset.ticketId = current;
    setCurrentTicket(current);
    let resolve;
    request = () => new Promise(r => { resolve = r; });
    const task = generateAITags(current);
    change(); panel.innerHTML = 'Other screen';
    resolve({ ai_tags: [{ tag: 'new', confidence: 90, accepted: false }] }); await task;
    expect(panel.innerHTML).toBe('Other screen');
    expect(tickets[0].aiTagGeneration.pending).toBe(false);
  }
});
test('escapes model tag text and renders accessible buttons', () => {
  tickets[0].aiTags = [{ tag: '<img src=x>', conf: 99, accepted: false }];
  const html = renderAITags(tickets[0]);
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img');
  expect(html).toContain('aria-live="polite"');
});
test('keeps keyboard focus in the panel while loading and returns it to the action', async () => {
  const focusButton = mock(() => {});
  panel.contains = () => true;
  panel.focus = mock(() => {});
  panel.querySelector = () => ({ focus: focusButton });
  await generateAITags(current);
  expect(panel.focus).toHaveBeenCalledTimes(1);
  expect(focusButton).toHaveBeenCalledTimes(1);
});
