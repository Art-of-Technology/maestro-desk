import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { matchesContact } from '../web/js/customers/contacts.js';

const source = file => readFileSync(new URL(`../web/js/${file}`, import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/\bexport /g, '');
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function ticketSearch(query, customers = [], brand = 'brand') {
  const state = {
    FILTER_QUERY: query, FILTER_AGENT: 'all', FILTER_CATEGORY: 'all', FILTER_PRIORITY: 'all', FILTER_SENTIMENT: 'all',
    SESSION: null, TICKET_SELECTED_IDS: new Set(), CUSTOMERS: customers, TICKETS: [], AGENTS: [], CHANNELS: [], MACROS: [],
    getWorkspaceId: () => 'workspace', getJwt: () => 'session', getBrandId: () => brand,
    statusChoice: () => null, statusOptions: () => [], statusLabel: t => t.status, statusSelectOptions: () => '',
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

function mainSearch(customers = [], brand = 'brand', lookup = async () => {}) {
  const actions = {}, mouseActions = {}, classes = new Set(), opened = [];
  const input = { value: '', blur() {}, focus() {}, setSelectionRange() {} };
  const results = { innerHTML: '', classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) } };
  const api = runInNewContext(source('global-search/index.js') + '\n({globalSearch, gsKey, searchPageSetQuery, renderSearchResults})', {
    CUSTOMERS: customers.map(c => ({ id: 'C-1', first: '', last: '', username: '', brand: '', email: '', vip: 'None', ...c })),
    TICKETS: [], AGENTS: [], KB_ARTICLES: [], TAG_LIBRARY: [], SEARCH_PAGE_FILTER: 'all',
    getBrandId: () => brand, matchesContact, lookupPlayerQuery: lookup,
    window: { escHtml: esc, escAttr: esc },
    document: { getElementById: id => id === 'gs-results' ? results : input },
    registerActions: map => Object.assign(actions, map), registerMousedownActions: map => Object.assign(mouseActions, map), registerInputActions() {},
    navTo: page => opened.push(page), renderPage() {}, MouseEvent: class { constructor(type) { this.type = type; } },
  });
  return { ...api, actions, mouseActions, results, input, opened, classes,
    surfaces(query) { api.globalSearch(query); api.searchPageSetQuery(query); return [results.innerHTML, api.renderSearchResults()]; },
  };
}

test('main search offers an escaped lookup in both surfaces without requiring ticket history', () => {
  const h = mainSearch();
  for (const html of h.surfaces('  MixedCase+tag@example.com  ')) {
    expect(html).toContain('data-action="gs.lookup" data-query="MixedCase+tag@example.com"');
    expect(html).toContain('Look up in Maestro');
  }
  for (const html of h.surfaces('user"<name')) expect(html).toContain('data-query="user&quot;&lt;name"');
  for (const html of h.surfaces('Dashboard')) expect(html).toContain('data-action="gs.lookup"');
  expect(mainSearch([{ brand: 'Example' }]).surfaces('Example').every(html => html.includes('data-action="gs.lookup"'))).toBe(true);
});

test('main search hides lookup for blank queries, missing brands and existing contacts', () => {
  for (const [query, customers, brand] of [
    ['  ', [], 'brand'], ['unknown', [], null],
    ...[{ email: 'person@example.com' }, { emails: [{ value: 'person@example.com' }] },
      { username: 'person@example.com' }, { first: 'person@example.com' }]
      .map(c => ['PERSON@EXAMPLE.COM', [c], 'brand']),
  ]) {
    for (const html of mainSearch(customers, brand).surfaces(query)) expect(html).not.toContain('data-action="gs.lookup"');
  }
});

test('main search hands off once, clears its dropdown and preserves lookup errors', async () => {
  for (const failure of [null, { status: 404 }, { status: 503, message: 'Lookup unavailable' }]) {
    const player = playerLookup('brand', failure);
    const h = mainSearch([], 'brand', query => player.actions['players.lookupQuery']({ query }));
    h.input.value = 'MixedCase+tag@example.com';
    h.globalSearch(h.input.value);
    await h.actions['gs.lookup']({ query: h.input.value });
    expect(h.input.value).toBe('');
    expect(h.results.innerHTML).toBe('');
    expect(h.classes.has('show')).toBe(false);
    expect(player.calls).toEqual([{ path: '/api/v1/maestro/players?email=MixedCase%2Btag%40example.com', options: { brand: true } }]);
    expect(player.renders[0]).toContain('value="MixedCase+tag@example.com"');
    if (failure) expect(player.renderPlayerLookupView()).toContain(failure.status === 404 ? 'No player found' : 'Lookup unavailable');
  }
});

test('main search keyboard activates lookup buttons and retains existing result navigation', async () => {
  for (const button of [true, false]) {
    const calls = [], active = new Set(), h = mainSearch();
    const item = { dataset: button ? { action: 'gs.lookup' } : {},
      classList: { add: x => active.add(x), remove: x => active.delete(x) }, scrollIntoView() {},
      click: () => calls.push('lookup'), dispatchEvent: event => calls.push(event.type),
    };
    h.results.querySelectorAll = () => [item];
    h.results.querySelector = () => active.has('active') ? item : null;
    h.globalSearch('unknown');
    const key = key => h.gsKey({ key, target: h.input, preventDefault() {} });
    key('ArrowDown'); key('Enter');
    expect(calls).toEqual([button ? 'lookup' : 'mousedown']);
    key('Escape'); expect(h.classes.has('show')).toBe(false);
  }
});

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
