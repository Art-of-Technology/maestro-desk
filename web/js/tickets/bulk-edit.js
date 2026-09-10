import { applySavedActivity } from '../core/ticket-history.js';
import { TICKETS, TAG_LIBRARY } from '../core/data.js';
import { SESSION, TICKET_SELECTED_IDS, CURRENT_PAGE, CURRENT_TICKET } from '../core/state.js';
import { apiGet, apiPost, apiPatch, getJwt, getWorkspaceId } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';
import { showToast } from '../core/toast.js';
import { logTicketEvent } from '../core/activity-log.js';
import { renderPage, updateNavBadges } from '../core/router.js';
import { invalidateWorkQueue } from './work-queue.js';
import { refreshTicketSLA } from './sla.js';
import { saveBulkChanges } from './bulk-save.js';
import { normaliseBulkTag, confirmsBulkEdit } from './bulk-edit-values.js';

let busy = false;
let tagRefreshVersion = 0;
const priorities = ['urgent', 'high', 'normal', 'low'];

async function refreshTags(sameContext) {
  const version = ++tagRefreshVersion;
  try {
    const response = await apiGet('/api/v1/tags');
    if (!sameContext() || version !== tagRefreshVersion) return;
    if (!Array.isArray(response?.tags) || response.tags.some(t => typeof t.tag !== 'string' || !Number.isFinite(t.count))) {
      throw new Error('Invalid tag counts');
    }
    TAG_LIBRARY.splice(0, TAG_LIBRARY.length, ...response.tags.map(t => ({ tag: t.tag, count: t.count, type: t.kind, conf: t.ai_confidence })));
  } catch {
    if (sameContext() && version === tagRefreshVersion) showToast('Could not refresh tag counts. Reload to try again.', 'warn');
  }
}

export function showBulkEdit(kind, initialValue = '') {
  if (!TICKET_SELECTED_IDS.size || (kind === 'priority' && !priorities.includes(initialValue))) return;
  if (busy) { showToast('Ticket changes are still saving.', 'info'); return; }
  const jwt = getJwt(), workspace = getWorkspaceId(), session = SESSION;
  const sameContext = () => getJwt() === jwt && getWorkspaceId() === workspace && SESSION === session;
  let pending = [...TICKET_SELECTED_IDS].map(id => ({ id, _uuid: TICKETS.find(t => t.id === id)?._uuid }));
  const isTag = kind === 'tag';
  const n = pending.length;
  const input = isTag
    ? '<label class="form-label" for="bulk-edit-value">Tag</label><input class="form-input" id="bulk-edit-value" maxlength="64" placeholder="e.g. priority-customer" autocomplete="off"/><p style="font-size:12px">Lowercase letters, numbers and hyphens. Existing tags are kept.</p>'
    : `<label class="form-label" for="bulk-edit-value">Priority</label><select class="form-input" id="bulk-edit-value">${priorities.map(p => `<option value="${p}" ${p === initialValue ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select>`;
  showModal(`${isTag ? 'Tag' : 'Set priority on'} ${n} ticket${n === 1 ? '' : 's'}`,
    `<div class="form-row">${input}</div><div id="bulk-edit-result" role="status" style="font-size:13px;line-height:1.5"></div>`, execute, isTag ? 'Apply tag' : 'Save priority');
  // Choosing a priority in the bulk toolbar starts the save, as before.
  if (!isTag) void execute();

  async function execute() {
    if (busy || !sameContext()) return;
    const field = document.getElementById('bulk-edit-value');
    const status = document.getElementById('bulk-edit-result');
    const confirm = document.querySelector('#modal-container [data-action="modal.confirm"]');
    if (!field || !status || !confirm) return;
    const value = isTag ? normaliseBulkTag(field.value) : field.value;
    if (isTag ? !value || value.length > 64 : !priorities.includes(value)) {
      status.textContent = isTag ? 'Enter a tag of 1–64 letters, numbers or hyphens.' : 'Choose a priority.';
      field.focus(); return;
    }
    const isCurrent = () => sameContext() && field.isConnected;
    busy = true;
    try {
      field.disabled = true; confirm.disabled = true; confirm.textContent = 'Saving…';
      status.textContent = `Saving changes to ${pending.length} ticket${pending.length === 1 ? '' : 's'}…`;
      const result = await saveBulkChanges({ tickets: pending, isCurrent,
        save: ticket => {
          if (!jwt) return Promise.resolve(isTag ? { tag: value } : { ticket: { id: ticket._uuid || ticket.id, priority_key: value } });
          if (!ticket._uuid) throw new Error('This ticket is no longer available. Refresh the list.');
          return isTag ? apiPost(`/api/v1/tickets/${ticket._uuid}/tags`, { tag: value })
            : apiPatch(`/api/v1/tickets/${ticket._uuid}`, { priority_key: value });
        },
        validate: (response, ticket) => confirmsBulkEdit(kind, value, response, ticket),
        onSaved: (ticket, response) => {
          const t = TICKETS.find(t => ticket._uuid ? t._uuid === ticket._uuid : t.id === ticket.id);
          if (t && isTag) {
            t.tags ||= [];
            if (!t.tags.includes(value)) {
              t.tags.push(value);
              if (!jwt) logTicketEvent(t.id, 'tag', `Tagged: ${value} (bulk)`);
              if (!jwt) {
                const lib = TAG_LIBRARY.find(t => t.tag === value);
                if (lib) lib.count++; else TAG_LIBRARY.push({ tag: value, count: 1, type: 'manual', conf: null });
              }
            }
          } else if (t) {
            if (!jwt && t.priority !== value) logTicketEvent(t.id, 'priority', `Priority: ${t.priority} → ${value} (bulk)`);
            t.priority = value;
            refreshTicketSLA(t);
          }
          if (t && jwt) applySavedActivity(t, response);
          TICKET_SELECTED_IDS.delete(ticket.id);
        },
      });
      if (!isCurrent()) return;
      pending = result.failed.map(f => f.ticket);
      if (pending.length) {
        status.innerHTML = `${result.saved.length} saved; ${pending.length} failed. Failed tickets remain selected.<ul>${result.failed.map(f => `<li>${window.escHtml(f.ticket.id)}: ${window.escHtml(f.message)}</li>`).join('')}</ul>`;
      } else {
        closeModal();
        showToast(`${isTag ? 'Tag applied to' : 'Priority saved on'} ${result.saved.length} ticket${result.saved.length === 1 ? '' : 's'}.`, 'success');
      }
    } finally {
      busy = false;
      if (field.isConnected) {
        if (!sameContext()) closeModal();
        else { field.disabled = false; confirm.disabled = false; confirm.textContent = 'Retry failed'; }
      }
      if (sameContext()) {
        invalidateWorkQueue();
        updateNavBadges();
        if (CURRENT_PAGE === 'tickets' && !CURRENT_TICKET) renderPage('tickets');
        if (isTag && jwt) void refreshTags(sameContext);
      }
    }
  }
}
