import { AGENTS, TICKETS } from '../core/data.js';
import { SESSION } from '../core/state.js';
import { apiPost } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';
import { showToast } from '../core/toast.js';
import { logTicketEvent } from '../core/activity-log.js';
import { applySavedActivity } from '../core/ticket-history.js';
import { refreshTicketSLA } from './sla.js';

export const CLOSURE_REASONS = { spam: 'Spam', abuse: 'Abuse', duplicate: 'Duplicate', other: 'Other' };

export function closureDetails(t) {
  if (t.status !== 'closed') return '';
  const actor = AGENTS.find(a => a.userId === t.closedByUserId)?.name;
  return `<div class="ts-section"><div class="ts-heading">Closed without resolution</div>
    <div>${window.escHtml(CLOSURE_REASONS[t.closureReason] || 'Other')}</div>
    ${actor ? `<div class="closure-date">Closed by ${window.escHtml(actor)}</div>` : ''}
    ${t.closedAt ? `<div class="closure-date">${window.escHtml(new Date(t.closedAt).toLocaleString())}</div>` : ''}
    ${t.closureNote ? `<div class="closure-note">${window.escHtml(t.closureNote)}</div>` : ''}
    <div class="closure-date">No satisfaction survey. A new customer reply reopens the ticket.</div></div>`;
}

export function showCloseTickets(ids, onChanged) {
  const targets = ids.map(id => TICKETS.find(t => t.id === id)).filter(t => t && !t.mergedInto && t.status !== 'closed');
  if (!targets.length) { showToast('These tickets are already closed or merged.'); return; }
  let busy = false;
  showModal(targets.length === 1 ? 'Close without resolution' : `Close ${targets.length} tickets without resolution`, `
    <p>No customer email or satisfaction survey will be sent. You can reopen the tickets later.</p>
    <div class="form-row"><label class="form-label" for="closure-reason">Reason (required)</label>
      <select class="form-input" id="closure-reason" required>
        <option value="">Choose a reason</option>
        ${Object.entries(CLOSURE_REASONS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}
      </select></div>
    <div class="form-row"><label class="form-label" for="closure-note">Internal note (optional)</label>
      <textarea class="form-input" id="closure-note" rows="3" maxlength="4000"></textarea></div>
    <div id="closure-error" role="alert"></div>`, async () => {
    if (busy) return;
    const reasonInput = document.getElementById('closure-reason');
    const error = document.getElementById('closure-error');
    const reason = reasonInput.value;
    if (!CLOSURE_REASONS[reason]) { error.textContent = 'Choose a closure reason.'; reasonInput.focus(); return; }
    const note = document.getElementById('closure-note').value.trim();
    busy = true;
    const button = error.closest('.modal').querySelector('[data-action="modal.confirm"]');
    button.disabled = true; button.textContent = 'Closing…'; error.textContent = '';
    const succeeded = [], failed = [];
    for (const t of targets) {
      try {
        const result = t._uuid ? await apiPost(`/api/v1/tickets/${t._uuid}/close`, { reason, note }) : null;
        applySavedActivity(t, result);
        t.status = 'closed';
        t.closureReason = result?.ticket.closure_reason || reason;
        t.closureNote = result ? result.ticket.closure_note : note || null;
        t.closedAt = result?.ticket.closed_at || new Date().toISOString();
        t.closedByUserId = result?.ticket.closed_by_user_id || SESSION?.userId || null;
        t.resolvedAt = null; t.snoozedUntil = null; t.snoozedAt = null; t.snoozeReason = null;
        t._detailLoaded = false;
        refreshTicketSLA(t);
        if (!t._uuid) logTicketEvent(t.id, 'system', `Closed without resolution: ${CLOSURE_REASONS[reason]}.${note ? '\n' + note : ''}`);
        succeeded.push(t.id);
      } catch (err) { failed.push(`${t.id}: ${err?.message || 'Could not close ticket.'}`); }
    }
    if (error.isConnected) {
      if (!failed.length) closeModal();
      else {
        error.textContent = failed.join('\n');
        button.disabled = false; button.textContent = 'Retry failed tickets';
        targets.splice(0, targets.length, ...targets.filter(t => !succeeded.includes(t.id)));
      }
    }
    busy = false;
    if (succeeded.length) showToast(`${succeeded.length} ticket${succeeded.length === 1 ? '' : 's'} closed without resolution.`);
    await onChanged?.(succeeded);
  }, 'Close without resolution');
  const modal = document.getElementById('closure-reason').closest('.modal');
  modal.classList.add('closure-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Close without resolution');
  const reasonInput = document.getElementById('closure-reason');
  reasonInput.addEventListener('change', () => { document.getElementById('closure-error').textContent = ''; });
  reasonInput.focus();
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not(:disabled), select, textarea')];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}
