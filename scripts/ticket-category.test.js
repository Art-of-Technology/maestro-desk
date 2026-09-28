import { beforeEach, expect, mock, test } from 'bun:test';
import './bridge-smoke-shim-prefix.js';
import { CATEGORIES, TICKETS } from '../web/js/core/data.js';
import { setJwt, setWorkspaceId } from '../web/js/core/api-client.js';
import { changeTicketCategory, renderTicketCategory, ticketCategoryKey } from '../web/js/tickets/category.js';
import { loadTicketDetail } from '../web/js/core/bootstrap.js';
import { setCurrentTicket } from '../web/js/core/state.js';
import { changeTicketStatus, changeTicketPriority } from '../web/js/tickets/detail.js';

const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
window.escHtml = window.escAttr = escape;
let ticket;
beforeEach(() => {
  setJwt('test'); setWorkspaceId('workspace');
  CATEGORIES.splice(0, CATEGORIES.length,
    { key: 'General', label: 'General', is_active: true },
    { key: 'DueDiligence', label: 'Due Diligence', is_active: true },
    { key: 'Old', label: 'Retired category', is_active: false });
  ticket = { id: 'TK-23', _uuid: 'ticket-id', category: 'General', categoryKey: 'General', status: 'open', priority: 'normal', tags: ['keep-tag'], msgs: [] };
  TICKETS.splice(0, TICKETS.length, ticket);
  globalThis.fetch = mock(async (_url, opts) => ({ ok: true, text: async () => JSON.stringify({ ticket: { category_key: JSON.parse(opts.body).category_key } }) }));
});
test('uses stored keys with readable labels and preserves inactive or empty categories', () => {
  ticket.categoryKey = 'DueDiligence';
  expect(renderTicketCategory(ticket)).toContain('value="DueDiligence" selected>Due Diligence');
  ticket.categoryKey = 'Old';
  expect(renderTicketCategory(ticket)).toContain('value="Old" selected disabled>Retired category (inactive)');
  ticket.categoryKey = null;
  expect(renderTicketCategory(ticket)).toContain('value="" selected>Uncategorised');
  expect(renderTicketCategory(ticket)).not.toContain('value="Old"');
});
test('saves category without changing tags and reloads the canonical key from the API', async () => {
  expect(await changeTicketCategory(ticket.id, 'DueDiligence')).toBe(true);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ category_key: 'DueDiligence' });
  expect(ticket.tags).toEqual(['keep-tag']);
  expect(ticketCategoryKey(ticket)).toBe('DueDiligence');
  globalThis.fetch = mock(async () => ({ ok: true, text: async () => JSON.stringify({ ticket: {
    id: ticket._uuid, category_key: 'Old', status_key: 'open', priority_key: 'normal', tags: ['keep-tag'], messages: [],
  } }) }));
  await loadTicketDetail(ticket.id, { force: true });
  expect(ticketCategoryKey(ticket)).toBe('Old');
  expect(renderTicketCategory(ticket)).toContain('Retired category (inactive)');
});
test('keeps the previous category when saving fails and releases the pending state', async () => {
  globalThis.fetch = mock(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'Unknown or inactive category' }) }));
  expect(await changeTicketCategory(ticket.id, 'Old')).toBe(false);
  expect(ticketCategoryKey(ticket)).toBe('General');
  expect(ticket._categorySaving).toBe(false);
});
test('blocks duplicate saves and ignores a result after switching workspace', async () => {
  let finish;
  globalThis.fetch = mock(() => new Promise(r => { finish = r; }));
  const pending = changeTicketCategory(ticket.id, 'DueDiligence');
  expect(await changeTicketCategory(ticket.id, 'DueDiligence')).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  setWorkspaceId('another');
  finish({ ok: true, text: async () => JSON.stringify({ ticket: { category_key: 'DueDiligence' } }) });
  expect(await pending).toBe(false);
  expect(ticketCategoryKey(ticket)).toBe('General');
});
test('allows clearing the category and escapes configured labels', async () => {
  expect(await changeTicketCategory(ticket.id, '')).toBe(true);
  expect(ticketCategoryKey(ticket)).toBeNull();
  CATEGORIES[0].label = '<img src=x>';
  expect(renderTicketCategory(ticket)).toContain('&lt;img');
});

test('restores status and priority controls when saving fails', async () => {
  setCurrentTicket(ticket.id);
  globalThis.fetch = mock(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'Save failed' }) }));
  const originalQuery = document.querySelector;
  const control = { value: 'pending' };
  document.querySelector = () => control;
  try {
    await changeTicketStatus(ticket.id, 'pending');
    expect(control.value).toBe('open');
    control.value = 'urgent';
    await changeTicketPriority(ticket.id, 'urgent');
    expect(control.value).toBe('normal');
  } finally {
    document.querySelector = originalQuery;
  }
});
