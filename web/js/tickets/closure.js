import { AGENTS, CUSTOMERS, TICKETS } from '../core/data.js';
import { SESSION } from '../core/state.js';
import { apiPost, apiDelete, getWorkspaceId, getJwt } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';
import { showToast } from '../core/toast.js';
import { logTicketEvent } from '../core/activity-log.js';
import { applySavedActivity } from '../core/ticket-history.js';
import { refreshTicketSLA } from './sla.js';
import { statusChoice, DEFAULT_CLOSURE_REASONS } from './status-options.js';
import { markCloseReminder, clearCloseReminder } from './close-reminder.js';

export const CLOSURE_REASONS = { spam: 'Spam', abuse: 'Abuse', duplicate: 'Duplicate', other: 'Other' };

export function closureDetails(t) {
  const contact = CUSTOMERS.find(c => c.id === t.customerId);
  const spamNotice = contact?.isSpam ? `<div class="ts-section"><div class="ts-heading">Spam contact</div>
    <p>Future emails from this contact are closed as spam without a reply or survey.</p>
    <button type="button" class="btn btn-sm" data-action="td.unmarkSpam" data-ticket-id="${window.escAttr(t.id)}">Unmark contact as spam</button></div>` : '';
  if (t.status !== 'closed') return spamNotice;
  const actor = AGENTS.find(a => a.userId === t.closedByUserId)?.name;
  return `${spamNotice}<div class="ts-section"><div class="ts-heading">Closed without resolution</div>
    <div>${window.escHtml(t.statusReasonLabel || CLOSURE_REASONS[t.closureReason] || t.closureReason || 'No reason given')}</div>
    ${actor ? `<div class="closure-date">Closed by ${window.escHtml(actor)}</div>` : ''}
    ${t.closedAt ? `<div class="closure-date">${window.escHtml(new Date(t.closedAt).toLocaleString())}</div>` : ''}
    ${t.closureNote ? `<div class="closure-note">${window.escHtml(t.closureNote)}</div>` : ''}
    <div class="closure-date">No satisfaction survey.${contact?.isSpam ? '' : ' A new customer reply reopens the ticket.'}</div></div>`;
}

export function applyClosedTicket(t, result, reason, note = '', statusOption = 'closed') {
  const reasons = statusChoice(statusOption)?.reasons || DEFAULT_CLOSURE_REASONS;
  const selectedReason = reasons.find(r => r.key === reason);
  if (reason === 'spam') {
    const contact = CUSTOMERS.find(c => c.id === t.customerId);
    if (contact && !contact.erased && !contact.mergedInto) contact.isSpam = true;
  }
  applySavedActivity(t, result);
  t.status = 'closed';
  t.statusOption = result?.ticket.status_option_key || statusOption;
  t.statusSurveyEnabled = false;
  t.closureReason = result?.ticket.closure_reason || reason || null;
  t.statusReasonLabel = result?.ticket.status_reason_label || selectedReason?.label || null;
  t.closureNote = result ? result.ticket.closure_note : note || null;
  t.closedAt = result?.ticket.closed_at || new Date().toISOString();
  t.closedByUserId = result?.ticket.closed_by_user_id || SESSION?.userId || null;
  t.resolvedAt = null; t.snoozedUntil = null; t.snoozedAt = null; t.snoozeReason = null;
  t._detailLoaded = false;
  clearCloseReminder(t);
  refreshTicketSLA(t);
  if (!t._uuid) logTicketEvent(t.id, 'system', `Closed without resolution: ${selectedReason?.label || 'No reason given'}.${note ? '\n' + note : ''}`);
}

export function showCloseTickets(ids, onChanged, presetReason = '', statusOption = 'closed', sendReply = null) {
  const spam = presetReason === 'spam';
  const choice = statusChoice(statusOption);
  const reasons = choice?.reasons || DEFAULT_CLOSURE_REASONS;
  const required = spam || (choice?.reason_required ?? true);
  const targets = ids.map(id => TICKETS.find(t => t.id === id)).filter(t => t && !t.mergedInto && (spam || t.status !== 'closed'));
  if (!targets.length) { showToast('These tickets are already closed or merged.'); return; }
  let busy = false, replySent = false;
  const title = sendReply ? 'Send and close — no survey' : spam ? (targets.length === 1 ? 'Mark as spam' : `Mark ${targets.length} tickets as spam`) : (targets.length === 1 ? 'Close without resolution' : `Close ${targets.length} tickets without resolution`);
  const workspace = getWorkspaceId(), jwt = getJwt();
  showModal(title, `
    <p>${sendReply ? 'Your reply will use the normal AI and translation checks. After the email is sent, the ticket will close without a satisfaction survey.' : 'No customer email or satisfaction survey will be sent. You can reopen the tickets later.'}</p>
    ${reasons.some(r => r.key === 'spam' && r.is_active) ? '<p>Choosing Spam also marks linked contacts as spam. Future emails from their addresses in this workspace will be closed as spam. You can undo this from the contact or ticket.</p>' : ''}
    <div class="form-row"><label class="form-label" for="closure-reason">Reason (${required ? 'required' : 'optional'})</label>
      <select class="form-input" id="closure-reason" ${required ? 'required' : ''}${spam ? ' disabled' : ''}>
        <option value="">${required ? 'Choose a reason' : 'No reason'}</option>
        ${reasons.filter(r => r.is_active).map(r => `<option value="${window.escAttr(r.key)}"${r.key === presetReason ? ' selected' : ''}>${window.escHtml(r.label)}</option>`).join('')}
      </select></div>
    <div class="form-row"><label class="form-label" for="closure-note">Internal note (optional)</label>
      <textarea class="form-input" id="closure-note" rows="3" maxlength="4000"></textarea></div>
    <div id="closure-error" role="alert"></div>`, async () => {
    if (busy || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    const reasonInput = document.getElementById('closure-reason');
    const error = document.getElementById('closure-error');
    const reason = reasonInput.value;
    const selectedReason = reasons.find(r => r.key === reason && r.is_active);
    if ((required || reason) && !selectedReason) { error.textContent = 'Choose a closure reason.'; reasonInput.focus(); return; }
    const note = document.getElementById('closure-note').value.trim();
    busy = true;
    const button = error.closest('.modal').querySelector('[data-action="modal.confirm"]');
    button.disabled = true; button.textContent = 'Closing…'; error.textContent = '';
    if (sendReply) {
      setSendBusy(true);
      if (!replySent) {
        button.textContent = 'Sending…';
        try { replySent = await sendReply() === true; }
        catch (err) { error.textContent = err?.message || 'Could not send the reply.'; }
      }
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) {
        if (error.isConnected) closeModal();
        return;
      }
      if (replySent) targets.forEach(markCloseReminder);
      if (!error.isConnected) return;
      if (!replySent) {
        busy = false; setSendBusy(false);
        button.textContent = 'Send and close';
        error.textContent = error.textContent || 'Reply was not confirmed sent. The ticket is still open. Check the reply and email delivery status before trying again.';
        return;
      }
      button.textContent = 'Closing…';
    }
    const succeeded = [], failed = [];
    for (const t of targets) {
      if (workspace !== getWorkspaceId() || jwt !== getJwt() || !TICKETS.includes(t)) break;
      try {
        const result = t._uuid ? await apiPost(`/api/v1/tickets/${t._uuid}/close`, { reason, note, status_option_key: statusOption }) : null;
        if (workspace !== getWorkspaceId() || jwt !== getJwt()) {
          if (sendReply && error.isConnected) closeModal();
          return;
        }
        applyClosedTicket(t, result, reason, note, statusOption);
        succeeded.push(t.id);
      } catch (err) { failed.push(`${t.id}: ${err?.message || 'Could not close ticket.'}`); }
    }
    if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    if (error.isConnected) {
      if (!failed.length) closeModal();
      else {
        error.textContent = (replySent ? 'Reply sent. The ticket is still open. Retry closing only; your reply will not be sent again.\n' : '') + failed.join('\n');
        if (sendReply) setSendBusy(false);
        button.disabled = false; button.textContent = replySent ? 'Retry close only' : 'Retry failed tickets';
        button.focus();
        targets.splice(0, targets.length, ...targets.filter(t => !succeeded.includes(t.id)));
      }
    }
    busy = false;
    if (succeeded.length) showToast(`${succeeded.length} ticket${succeeded.length === 1 ? '' : 's'} ${reason === 'spam' ? 'marked as spam' : 'closed without resolution'}.`);
    await onChanged?.(succeeded);
  }, sendReply ? 'Send and close' : spam ? 'Mark as spam' : 'Close without resolution');
  const modal = document.getElementById('closure-reason').closest('.modal');
  function setSendBusy(on) {
    modal.querySelectorAll('button, select, textarea').forEach(el => { el.disabled = on; });
    document.getElementById('closure-reason').disabled = on || spam || replySent;
    document.getElementById('closure-note').disabled = on || replySent;
  }
  if (sendReply) {
    modal.querySelector('.modal-close').outerHTML = '<button type="button" class="modal-close" data-action="modal.close" aria-label="Cancel send and close">×</button>';
    modal.closest('.modal-bg').dataset.action = '';
  }
  modal.classList.add('closure-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', title);
  const reasonInput = document.getElementById('closure-reason');
  reasonInput.addEventListener('change', () => { document.getElementById('closure-error').textContent = ''; });
  (spam ? document.getElementById('closure-note') : reasonInput).focus();
  modal.addEventListener('keydown', event => {
    if (sendReply && busy) { event.preventDefault(); return; }
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not(:disabled), select:not(:disabled), textarea')];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

export async function unmarkSpamContact(customerId, onChanged) {
  const contact = CUSTOMERS.find(c => c.id === customerId);
  if (!contact) return;
  const workspace = getWorkspaceId();
  try {
    if (contact._uuid) await apiDelete(`/api/v1/customers/${contact._uuid}/spam`);
    if (workspace !== getWorkspaceId()) return;
    contact.isSpam = false;
    showToast('Contact unmarked as spam. Future emails will arrive normally.');
    await onChanged?.();
  } catch (err) { if (workspace === getWorkspaceId()) showToast(err?.message || 'Could not unmark contact as spam.', 'error'); }
}
