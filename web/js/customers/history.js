import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { buildTicketLookups, updateOrInsertTicket } from '../core/bootstrap.js';
import { registerActions } from '../core/event-delegation.js';
import { openTicket } from '../tickets/detail.js';
import { copyButton } from '../core/copy.js';

const histories = new WeakMap();
const loading = '<p role="status">Loading ticket history…</p>';

function current(root, state) {
  return root.isConnected && histories.get(root) === state
    && getJwt() === state.jwt && getWorkspaceId() === state.workspace;
}

function renderCounts(root, totals, statuses) {
  const slot = root.querySelector('[data-history-counts]');
  if (!slot) return;
  const tiles = [
    [(statuses.open || 0) + (statuses.escalated || 0), 'Open'],
    [totals.tickets, 'Total tickets'],
    [totals.csat_avg == null ? '—' : Number(totals.csat_avg).toFixed(1), `CSAT (${totals.csat_count})`],
  ];
  slot.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">${tiles.map(([value, label]) =>
    `<div class="r-tile"><div class="r-tile-n">${window.escHtml(String(value))}</div><div class="r-tile-l">${window.escHtml(label)}</div></div>`).join('')}</div>`;
}

function renderTickets(root, state) {
  const slot = root.querySelector('[data-history-tickets]');
  if (!slot) return;
  // Map into a private list; only opening a ticket adds it to the workspace list.
  const mapped = [], lookups = buildTicketLookups();
  for (const row of state.rows) updateOrInsertTicket(row, lookups, mapped);
  mapped.reverse();
  const rows = mapped.map(t => `<tr>
    <td class="bold"><button type="button" class="link" style="border:0;background:transparent;padding:4px 0;font:inherit;text-align:left;white-space:nowrap" data-action="customerHistory.openTicket" data-ticket-uuid="${window.escAttr(t._uuid)}">${window.escHtml(t.id)}</button>${copyButton(t.id, 'ticket number')}</td>
    <td><button type="button" class="link" style="border:0;background:transparent;padding:4px 0;font:inherit;text-align:left;white-space:nowrap" data-action="customerHistory.openTicket" data-ticket-uuid="${window.escAttr(t._uuid)}">${window.escHtml(t.subject)}</button></td>
    <td><span class="tag tag-${window.escAttr(t.status)}">${window.escHtml(t.status)}</span></td>
    <td><span class="tag tag-${window.escAttr(t.priority)}">${window.escHtml(t.priority)}</span></td>
    <td>${window.escHtml(t.agent || '')}</td>
    <td>${window.escHtml(t.sla)}</td><td>${window.escHtml(t.updated)}</td>
  </tr>`).join('');
  slot.innerHTML = `<div class="card"><div class="card-title">Tickets (${state.total})</div>
    ${rows ? `<div style="overflow-x:auto"><table class="tbl" style="min-width:700px"><thead><tr><th>ID</th><th>Subject</th><th>Status</th><th>Priority</th><th>Agent</th><th>SLA</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No tickets</p>'}
    <p role="status" data-history-status>${state.error ? "Couldn't load more tickets. Try again." : `${state.rows.length} of ${state.total} tickets`}</p>
    ${state.more ? `<button type="button" class="btn btn-sm" data-action="customerHistory.more" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Loading…' : 'Load more'}</button>` : ''}
  </div>`;
}

async function loadHistory(root, more = false) {
  if (!root) return;
  let state = histories.get(root);
  if (state?.loading) return;
  if (more && (!state || !current(root, state) || !state.more)) return;
  if (!more) {
    state = { jwt: getJwt(), workspace: getWorkspaceId(), rows: [], offset: 0, total: 0, limit: 25, more: false };
    histories.set(root, state);
  }
  if (!state.jwt || !state.workspace) return;
  state.loading = true;
  state.error = false;
  if (more) renderTickets(root, state);
  else {
    for (const slot of root.querySelectorAll('[data-history-counts], [data-history-tickets]')) slot.innerHTML = loading;
  }
  try {
    const path = `/api/v1/customers/${encodeURIComponent(root.dataset.customerHistory)}`;
    const result = await apiGet(more ? `${path}/tickets?limit=${state.limit}&offset=${state.offset}` : `${path}/summary`);
    if (!current(root, state)) return;
    const page = more ? result : result.tickets;
    const ids = new Set(state.rows.map(row => row.id));
    state.rows.push(...page.rows.filter(row => !ids.has(row.id)));
    state.offset = page.offset + page.rows.length;
    state.limit = page.limit;
    if (!more) {
      state.total = page.total;
      renderCounts(root, result.totals, result.by_status);
    }
    state.more = page.rows.length > 0 && state.offset < state.total;
  } catch {
    if (!current(root, state)) return;
    state.error = true;
    if (!more) {
      const counts = root.querySelector('[data-history-counts]');
      if (counts) counts.innerHTML = '<p role="status">Ticket counts unavailable</p>';
      const tickets = root.querySelector('[data-history-tickets]');
      if (tickets) tickets.innerHTML = '<div class="card"><div class="card-title">Tickets</div><p role="status">Couldn’t load ticket history.</p><button type="button" class="btn btn-sm" data-action="customerHistory.retry">Try again</button></div>';
    }
  } finally {
    state.loading = false;
    if (current(root, state) && (more || !state.error)) renderTickets(root, state);
  }
}

export function renderCustomerHistory(customer) {
  const id = customer._uuid;
  queueMicrotask(() => {
    const root = document.querySelector('[data-customer-history]');
    if (root?.dataset.customerHistory === id) void loadHistory(root);
  });
  return {
    kpis: `<div data-history-counts>${loading}</div>`,
    tickets: `<div data-history-tickets><div class="card"><div class="card-title">Tickets</div>${loading}</div></div>`,
  };
}

registerActions({
  'customerHistory.retry': (_ds, el) => loadHistory(el.closest('[data-customer-history]')),
  'customerHistory.more': (_ds, el) => loadHistory(el.closest('[data-customer-history]'), true),
  'customerHistory.openTicket': (ds, el) => {
    const root = el.closest('[data-customer-history]'), state = histories.get(root);
    if (!state || !current(root, state)) return;
    const row = state.rows.find(ticket => ticket.id === ds.ticketUuid);
    if (!row) return;
    updateOrInsertTicket(row);
    openTicket(row.display_id);
  },
});
