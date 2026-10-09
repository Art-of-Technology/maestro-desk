import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/js/customers/history.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
const ticket = n => ({ id: `uuid-${n}`, display_id: `TK-${n}`, subject: `<Older ticket ${n}>`, status_key: 'resolved', priority_key: 'normal' });
const summary = (rows = [ticket(1), ticket(2)], total = 3) => ({
  totals: { tickets: total, csat_count: 2, csat_avg: 4.5 }, by_status: { open: 1, escalated: 1 },
  tickets: { rows, total, limit: 2, offset: 0 },
});

function harness() {
  const actions = {}, calls = [], inserted = [], opened = [];
  const control = { jwt: 'session', workspace: 'workspace', response: summary(), hold: null, fail: false };
  const counts = { innerHTML: '' }, tickets = { innerHTML: '' };
  const root = { isConnected: true, dataset: { customerHistory: 'customer-uuid' },
    querySelector: selector => selector === '[data-history-counts]' ? counts : tickets,
    querySelectorAll: () => [counts, tickets] };
  const el = { closest: () => root };
  const esc = value => String(value).replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const context = {
    getJwt: () => control.jwt, getWorkspaceId: () => control.workspace,
    registerActions: map => Object.assign(actions, map),
    buildTicketLookups: () => ({}), copyButton: () => '',
    updateOrInsertTicket: (row, _lookups, target) => {
      if (!target) { inserted.push(row); return; }
      target.unshift({ _uuid: row.id, id: row.display_id, subject: row.subject, status: row.status_key, priority: row.priority_key, sla: 'ok', updated: 'Yesterday' });
    },
    openTicket: id => opened.push(id), window: { escHtml: esc, escAttr: esc },
    apiGet: async path => { calls.push(path); if (control.hold) await control.hold; if (control.fail) throw Error('Failed'); return control.response; },
    queueMicrotask: () => {}, document: { querySelector: () => root },
  };
  const api = runInNewContext(source + '\n({loadHistory, renderCustomerHistory})', context);
  return { ...api, actions, calls, inserted, opened, control, counts, tickets, root, el };
}

test('loads full-history counts and older tickets without filling the workspace ticket list', async () => {
  const h = harness();
  await h.loadHistory(h.root);
  expect(h.calls).toEqual(['/api/v1/customers/customer-uuid/summary']);
  expect(h.counts.innerHTML).toContain('4.5');
  expect(h.counts.innerHTML).toContain('>3</div>');
  expect(h.counts.innerHTML).toContain('>2</div>');
  expect(h.tickets.innerHTML).toContain('&lt;Older ticket 1>');
  expect(h.tickets.innerHTML.indexOf('TK-1')).toBeLessThan(h.tickets.innerHTML.indexOf('TK-2'));
  expect(h.inserted).toHaveLength(0);
  h.actions['customerHistory.openTicket']({ ticketUuid: 'uuid-1' }, h.el);
  expect(h.inserted).toEqual([ticket(1)]);
  expect(h.opened).toEqual(['TK-1']);
});

test('load more preserves rows, prevents duplicate requests, and reaches the final page', async () => {
  const h = harness(); await h.loadHistory(h.root);
  h.control.response = { rows: [ticket(2), ticket(3)], limit: 2, offset: 2 };
  let release; h.control.hold = new Promise(resolve => { release = resolve; });
  const pending = h.actions['customerHistory.more']({}, h.el);
  await h.actions['customerHistory.more']({}, h.el);
  expect(h.calls).toHaveLength(2);
  expect(h.tickets.innerHTML).toContain('disabled');
  release(); await pending;
  expect(h.calls[1]).toBe('/api/v1/customers/customer-uuid/tickets?limit=2&offset=2');
  expect(h.tickets.innerHTML).toContain('3 of 3 tickets');
  expect(h.tickets.innerHTML.match(/>TK-2</g)).toHaveLength(1);
  expect(h.tickets.innerHTML).not.toContain('customerHistory.more');
});

test('failed requests offer retry instead of claiming no tickets, and retain earlier pages', async () => {
  const h = harness(); h.control.fail = true;
  await h.loadHistory(h.root);
  expect(h.tickets.innerHTML).toContain('customerHistory.retry');
  expect(h.tickets.innerHTML).not.toContain('No tickets');
  expect(h.counts.innerHTML).toContain('unavailable');
  h.control.fail = false; await h.actions['customerHistory.retry']({}, h.el);
  h.control.fail = true; await h.actions['customerHistory.more']({}, h.el);
  expect(h.tickets.innerHTML).toContain('TK-1');
  expect(h.tickets.innerHTML).toContain("Couldn't load more");
  expect(h.tickets.innerHTML).not.toContain('disabled');
  h.control.fail = false; h.control.response = { rows: [ticket(3)], limit: 2, offset: 2 };
  await h.actions['customerHistory.more']({}, h.el);
  expect(h.calls.at(-1)).toContain('offset=2');
  expect(h.tickets.innerHTML).toContain('3 of 3 tickets');
});

test('empty history is shown only after a successful response', async () => {
  const h = harness(); h.control.response = summary([], 0);
  await h.loadHistory(h.root);
  expect(h.tickets.innerHTML).toContain('No tickets');
  expect(h.tickets.innerHTML).not.toContain('customerHistory.more');
});

test('late responses cannot update another profile, workspace or login', async () => {
  for (const drift of ['profile', 'workspace', 'jwt']) {
    const h = harness();
    let release; h.control.hold = new Promise(resolve => { release = resolve; });
    const pending = h.loadHistory(h.root);
    if (drift === 'profile') h.root.isConnected = false;
    else h.control[drift] = 'another';
    release(); await pending;
    expect(h.tickets.innerHTML).not.toContain('TK-1');
    expect(h.inserted).toHaveLength(0);
    h.actions['customerHistory.openTicket']({ ticketUuid: 'uuid-1' }, h.el);
    expect(h.opened).toHaveLength(0);
  }
});
