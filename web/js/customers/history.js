import { apiGet, apiPost, getJwt, getWorkspaceId } from '../core/api-client.js';
import { buildTicketLookups, updateOrInsertTicket } from '../core/bootstrap.js';
import { registerActions } from '../core/event-delegation.js';
import { statusLabel } from '../tickets/status-options.js';
import { openTicket } from '../tickets/detail.js';
import { copyButton } from '../core/copy.js';
import { translateActivity } from './activity-translation.js';
import { renderEmailNames } from './email-names.js';
import { can } from '../core/permissions.js';
import { showModal, closeModal } from '../core/modal.js';

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
    <td><span class="tag tag-${window.escAttr(t.status)}">${window.escHtml(statusLabel(t))}</span></td>
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

function renderNames(root, state) {
  const slot = root.querySelector('[data-history-email-names]');
  if (slot) slot.innerHTML = renderEmailNames(state.emailNames, can('customers.edit') && can('tickets.view_all'));
}

function renderActivity(root, state) {
  const slot = root.querySelector('[data-history-activity]');
  if (!slot) return;
  slot.innerHTML = '<div class="card"><div class="card-title">Activity timeline</div>'
    + (state.activity.length ? '<div class="cust-timeline">' + state.activity.map((a, index) => `<div class="cust-timeline-item role-${window.escAttr(a.role)}">
      <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:3px">
        <strong>${window.escHtml(a.author_label || '')}</strong>
        ${a.role === 'note' ? '<span class="note-mark">Note</span>' : a.role === 'ai' ? '<span class="ai-mark">AI</span>' : ''}
        <button type="button" class="btn btn-sm" data-action="customerHistory.openTicket" data-ticket-uuid="${window.escAttr(a.ticket_id)}">${window.escHtml(a.display_id)}</button>
        <span>${window.escHtml(a.created_at ? new Date(a.created_at).toLocaleString('en-GB') : '')}</span>
      </div>
      <div class="customer-activity-text" data-activity-text>${window.escHtml(a.message.t)}</div>
      ${a.body_truncated ? '<p>Preview only. Open the ticket for the full message.</p>' : ''}
      ${a.message.t.trim() ? `<button type="button" class="btn btn-sm" data-action="customerHistory.translateActivity" data-message-index="${index}">Translate</button>` : ''}
      <span role="status" data-activity-status></span>
    </div>`).join('') + '</div>' : '<p>No activity yet</p>') + '</div>';
}

async function loadHistory(root, more = false) {
  if (!root) return;
  let state = histories.get(root);
  if (state?.loading) return;
  if (more && (!state || !current(root, state) || !state.more)) return;
  if (!more) {
    state = { jwt: getJwt(), workspace: getWorkspaceId(), rows: [], activity: [], offset: 0, total: 0, limit: 25, more: false };
    histories.set(root, state);
  }
  if (!state.jwt || !state.workspace) return;
  state.loading = true;
  state.error = false;
  if (more) renderTickets(root, state);
  else {
    for (const slot of root.querySelectorAll('[data-history-counts], [data-history-tickets], [data-history-activity], [data-history-email-names]')) slot.innerHTML = loading;
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
      state.activity = result.activity.map(a => ({ ...a, message: { t: a.body || '' }, ticket: { id: a.display_id, _uuid: a.ticket_id } }));
      renderActivity(root, state);
      state.emailNames = result.email_names;
      renderNames(root, state);
    }
    state.more = page.rows.length > 0 && state.offset < state.total;
  } catch {
    if (!current(root, state)) return;
    state.error = true;
    if (!more) {
      const names = root.querySelector('[data-history-email-names]');
      if (names) names.innerHTML = '<section class="card customer-email-names"><div class="card-title">Name comparison</div><p role="status">Couldn’t load names.</p><button type="button" class="btn btn-sm" data-action="customerHistory.retry">Try again</button></section>';
      const activity = root.querySelector('[data-history-activity]');
      if (activity) activity.innerHTML = '<div class="card"><div class="card-title">Activity timeline</div><p role="status">Couldn’t load activity.</p><button type="button" class="btn btn-sm" data-action="customerHistory.retry">Try again</button></div>';
      const counts = root.querySelector('[data-history-counts]');
      if (counts) counts.innerHTML = '<p role="status">Ticket counts unavailable</p>';
      const tickets = root.querySelector('[data-history-tickets]');
      if (tickets) tickets.innerHTML = '<div class="card"><div class="card-title">Tickets</div><p role="status">Couldn’t load ticket history.</p><button type="button" class="btn btn-sm" data-action="customerHistory.retry">Try again</button></div>';
    }
  } finally {
    state.loading = false;
    if (current(root, state) && (more || !state.error)) renderTickets(root, state);
    if (current(root, state) && state.refreshAfterLoad) void loadHistory(root);
  }
}

export function refreshCustomerHistory(customerId) {
  const root = document.querySelector('[data-customer-history]');
  if (root?.dataset.customerHistory !== customerId) return;
  const state = histories.get(root);
  if (state?.loading) { state.refreshAfterLoad = true; return; }
  void loadHistory(root);
}

export function renderCustomerHistory(customer) {
  const id = customer._uuid;
  queueMicrotask(() => {
    const root = document.querySelector('[data-customer-history]');
    if (root?.dataset.customerHistory === id) void loadHistory(root);
  });
  return {
    kpis: `<div data-history-counts>${loading}</div>`,
    timeline: `<div data-history-activity><div class="card"><div class="card-title">Activity timeline</div><p role="status">Loading activity…</p></div></div>`,
    tickets: `<div data-history-tickets><div class="card"><div class="card-title">Tickets</div>${loading}</div></div>`,
  };
}

registerActions({
  'customerHistory.reviewName': (ds, el) => {
    const root = el.closest('[data-customer-history]'), state = histories.get(root);
    if (!state || !current(root, state) || !can('customers.edit') || !can('tickets.view_all')) return;
    const entry = state.emailNames?.entries.find(e => e.review_key === ds.reviewKey && e.mismatch && !e.reviewed);
    if (!entry) return;
    let pending = false;
    showModal('Review name difference', `<p>Email sender name: <strong>${window.escHtml(entry.sender_name)}</strong><br>Account holder name: <strong>${window.escHtml(state.emailNames.account_holder_name)}</strong></p>
      <label class="form-label" for="name-review-reason">Reason for accepting this difference</label>
      <textarea class="form-input" id="name-review-reason" maxlength="1000" required placeholder="For example, a middle name or evidence of a formal name change"></textarea>
      <p>This records your review. It does not verify email ownership. The warning returns if either name changes.</p>
      <p role="status" id="name-review-error"></p>`, async () => {
      const reasonEl = document.getElementById('name-review-reason'), errorEl = document.getElementById('name-review-error');
      if (pending || !reasonEl || !errorEl) return;
      if (!current(root, state)) { errorEl.textContent = 'The profile has changed. Close this window and try again.'; return; }
      const reason = reasonEl.value.trim();
      if (!reason) { errorEl.textContent = 'Enter a reason for accepting this difference.'; reasonEl.focus(); return; }
      pending = true;
      const confirm = document.querySelector('#modal-container [data-action="modal.confirm"]');
      if (confirm) confirm.disabled = true;
      errorEl.textContent = 'Saving review…';
      try {
        const result = await apiPost('/api/v1/customers/' + encodeURIComponent(root.dataset.customerHistory) + '/name-review', { review_key: entry.review_key, reason });
        if (!current(root, state)) return;
        state.emailNames = result.email_names;
        renderNames(root, state);
        if (reasonEl.isConnected) closeModal();
      } catch (error) {
        if (current(root, state) && errorEl.isConnected) errorEl.textContent = error.message || 'Couldn’t save the review. Try again.';
      } finally {
        pending = false;
        if (confirm?.isConnected) confirm.disabled = false;
      }
    }, 'Mark as reviewed');
    document.getElementById('name-review-reason')?.focus();
  },
  'customerHistory.retry': (_ds, el) => loadHistory(el.closest('[data-customer-history]')),
  'customerHistory.more': (_ds, el) => loadHistory(el.closest('[data-customer-history]'), true),
  'customerHistory.translateActivity': (ds, el) => {
    const root = el.closest('[data-customer-history]'), state = histories.get(root);
    if (!state || !current(root, state)) return;
    const entry = state.activity[Number(ds.messageIndex)];
    if (entry) return translateActivity(ds, el, entry);
  },
  'customerHistory.openTicket': async (ds, el) => {
    const root = el.closest('[data-customer-history]'), state = histories.get(root);
    if (!state || !current(root, state)) return;
    let row = state.rows.find(ticket => ticket.id === ds.ticketUuid);
    if (!row && !state.activity.some(a => a.ticket_id === ds.ticketUuid)) return;
    if (el.disabled) return;
    const status = el.closest('.cust-timeline-item')?.querySelector('[data-activity-status]');
    el.disabled = true;
    try {
      if (!row) {
        if (status) status.textContent = 'Opening ticket…';
        row = (await apiGet('/api/v1/tickets/' + encodeURIComponent(ds.ticketUuid))).ticket;
      }
      if (!current(root, state)) return;
      if (!row) throw new Error('Ticket unavailable');
      updateOrInsertTicket(row);
      openTicket(row.display_id);
    } catch {
      if (current(root, state) && status) status.textContent = 'Couldn’t open ticket. Try again.';
    } finally {
      el.disabled = false;
    }
  },
});
