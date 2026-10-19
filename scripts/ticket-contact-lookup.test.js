import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { matchesContact } from '../web/js/customers/contacts.js';

const source = file => readFileSync(new URL(`../web/js/${file}`, import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function ticketSearch(query, customers = [], brand = 'brand') {
  const state = {
    FILTER_QUERY: query, FILTER_AGENT: 'all', FILTER_CATEGORY: 'all', FILTER_PRIORITY: 'all', FILTER_SENTIMENT: 'all',
    SESSION: null, TICKET_SELECTED_IDS: new Set(), CUSTOMERS: customers, TICKETS: [], AGENTS: [], CHANNELS: [], MACROS: [],
    getWorkspaceId: () => 'workspace', getJwt: () => 'session', getBrandId: () => brand,
    workQueueState: () => ({ ready: true }), refreshQueueUrgency() {}, isOutstanding: () => true,
    inboxLabel: () => '', matchesContact, window: { escHtml: esc, escAttr: esc, canDeleteRecords: () => false },
    registerActions() {}, registerChangeActions() {}, registerInputActions() {},
  };
  return runInNewContext(source('tickets/list.js') + '\nSAVED_SEARCHES_LOADED = true; renderTickets();', state);
}

function playerLookup(brand = 'brand', failure = null) {
  const actions = {}, calls = [], pages = [], renders = [];
  let api;
  const render = page => { pages.push(page); renders.push(api.renderPlayerLookupView()); };
  api = runInNewContext(source('customers/player-lookup.js') + '\n({renderPlayerLookupView, playerLookupActive})', {
    CUSTOMERS: [], getBrandId: () => brand, nav: render, renderPage: render,
    apiGet: async (path, options) => { calls.push({ path, options }); if (failure) throw failure; return { member: { email: 'person@example.com' } }; },
    document: { getElementById: () => null }, window: { escHtml: esc, escAttr: esc }, copyButton: () => '',
    registerActions: map => Object.assign(actions, map), registerChangeActions() {}, registerInputActions() {},
  });
  return { actions, calls, pages, renders, ...api };
}

test('ticket search offers a lookup with the trimmed, escaped original query', () => {
  const html = ticketSearch('  MixedCase+tag@example.com  ');
  expect(html).toContain('data-action="players.lookupQuery" data-query="MixedCase+tag@example.com"');
  expect(html).toContain('Look up in Maestro');
  expect(ticketSearch('user"<name')).toContain('data-query="user&quot;&lt;name"');
});

test('lookup is hidden for blank searches, missing brands and matching local contacts', () => {
  expect(ticketSearch('   ')).not.toContain('players.lookupQuery');
  expect(ticketSearch('unknown', [], null)).not.toContain('players.lookupQuery');
  for (const customer of [
    { email: 'person@example.com' },
    { emails: [{ value: 'person@example.com' }] },
    { username: 'Person@example.com' },
    { first: 'Person@example.com', last: 'Smith' },
  ]) {
    expect(ticketSearch('PERSON@EXAMPLE.COM', [customer])).not.toContain('players.lookupQuery');
  }
  expect(ticketSearch('missing@example.com', [{ email: 'other@example.com' }])).toContain('players.lookupQuery');
});

test('lookup action opens Customers, prefills the value and runs the brand-scoped lookup once', async () => {
  for (const query of ['MixedCase+tag@example.com', 'Player_Name']) {
    const h = playerLookup();
    await h.actions['players.lookupQuery']({ query: `  ${query}  ` });
    expect(h.playerLookupActive()).toBe(true);
    expect(h.pages.every(page => page === 'customers')).toBe(true);
    expect(h.renders[0]).toContain(`value="${query}"`);
    expect(h.calls).toEqual([{ path: `/api/v1/maestro/players?email=${encodeURIComponent(query)}`, options: { brand: true } }]);
  }
});

test('lookup keeps the query on not-found and API errors', async () => {
  for (const failure of [{ status: 404 }, { status: 503, message: 'Lookup unavailable' }]) {
    const h = playerLookup('brand', failure);
    await h.actions['players.lookupQuery']({ query: 'missing@example.com' });
    const html = h.renderPlayerLookupView();
    expect(html).toContain('value="missing@example.com"');
    expect(html).toContain(failure.status === 404 ? 'No player found' : 'Lookup unavailable');
  }
});

test('lookup action ignores empty queries and missing brands', async () => {
  for (const [brand, query] of [['brand', '  '], [null, 'person@example.com']]) {
    const h = playerLookup(brand);
    await h.actions['players.lookupQuery']({ query });
    expect(h.calls).toHaveLength(0);
    expect(h.pages).toHaveLength(0);
    expect(h.playerLookupActive()).toBe(false);
  }
});
