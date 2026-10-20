import { statusOptions, statusOptionsState, STATUS_CATEGORIES, DEFAULT_CLOSURE_REASONS, loadStatusOptions } from '../tickets/status-options.js';
import { apiPost, apiPut, getWorkspaceId, getJwt } from '../core/api-client.js';
import { renderPage } from '../core/router.js';
import { showModal, closeModal } from '../core/modal.js';
import { showToast } from '../core/toast.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';

let categoryDrafts, previousCategory;
export function renderTicketStatuses() {
  if (!window.isAdmin()) return '<div class="page ticket-status-settings"><div class="topbar"><h1 class="tb-title">Ticket statuses</h1></div><p class="report-note">Brand admin permission is required to manage ticket statuses.</p></div>';
  const state = statusOptionsState();
  if (!state.ready && !state.error) queueMicrotask(async () => { await loadStatusOptions(); if (document.body.dataset.currentPage === 'ticket-statuses') renderPage('ticket-statuses'); });
  return `<div class="page ticket-status-settings"><div class="topbar"><h1 class="tb-title">Ticket statuses</h1><div class="status-settings-actions"><button class="btn" data-action="statuses.reload">Refresh</button><button class="btn btn-solid" data-action="statuses.new" ${!state.ready || !getWorkspaceId() ? 'disabled' : ''}>Add status</button></div></div>
    <div class="report-note">Statuses belong to this brand. The workflow category controls reporting, SLAs and reopening. Survey settings apply when an agent next selects a status; previous selections keep their survey rule.</div>
    ${state.error ? `<p class="report-note" role="alert">${window.escHtml(state.error)}</p>` : !state.ready ? '<p class="report-note" role="status">Loading ticket statuses…</p>' : `<div class="status-settings-table" tabindex="0" role="region" aria-label="Ticket status options"><table class="tbl"><thead><tr><th scope="col">Name</th><th scope="col">Workflow category</th><th scope="col">Survey</th><th scope="col">Reason</th><th scope="col">Availability</th><th scope="col"><span class="stat-sr-only">Actions</span></th></tr></thead><tbody>${statusOptions({ includeRetired: true }).map(s => `<tr><td>${window.escHtml(s.label)}</td><td><span class="tag tag-${s.base_key}">${window.escHtml(s.base_key)}</span></td><td>${s.send_survey ? 'Send on resolution' : 'Never send'}</td><td>${s.reason_required ? 'Required' : 'Optional'} · ${s.reasons.filter(r => r.is_active).length} available</td><td>${s.is_active ? 'Available' : 'Retired'}</td><td><button class="btn btn-sm" data-action="statuses.edit" data-key="${window.escAttr(s.key)}" ${!getWorkspaceId() ? 'disabled' : ''}>Edit<span class="stat-sr-only"> ${window.escHtml(s.label)}</span></button></td></tr>`).join('')}</tbody></table></div>`}
    <p class="report-note">Built-in statuses stay available. Retired statuses remain on existing tickets. Changing a status cannot recall a survey that has already been sent.</p></div>`;
}
function edit(key) {
  if (!window.isAdmin() || !getWorkspaceId()) return;
  const old = key ? statusOptions({ includeRetired: true }).find(s => s.key === key) : null;
  if (key && !old) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  categoryDrafts = new Map(); previousCategory = old?.base_key || STATUS_CATEGORIES[0];
  const trigger = document.activeElement;
  let busy = false;
  showModal(old ? 'Edit ticket status' : 'Add ticket status', `
    <div class="form-row"><label class="form-label" for="status-name">Name</label><input class="form-input" id="status-name" maxlength="80" required value="${window.escAttr(old?.label || '')}" placeholder="e.g. Resolved — no survey"></div>
    <div class="form-row"><label class="form-label" for="status-category">Workflow category</label><select class="form-input" id="status-category" data-change-action="statuses.category" ${old ? 'disabled' : ''}>${STATUS_CATEGORIES.map(k => `<option value="${k}" ${k === old?.base_key ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select><p>The category cannot be changed after creation.</p></div>
    <div class="form-row"><label class="form-label" for="status-survey">Satisfaction survey</label><select class="form-input" id="status-survey"><option value="false">Never send</option><option value="true" ${old?.send_survey ? 'selected' : ''}>Send on resolution</option></select></div>
    <label class="auth-check"><input id="status-reason-required" type="checkbox" ${old?.reason_required ? 'checked' : ''}> Reason required</label>
    <fieldset class="status-reasons"><legend>Available reasons</legend><p>Rename reasons or retire them from new selections. Recorded reasons stay in ticket history.</p>
      <div id="status-reasons">${(old?.reasons || []).map(r => reasonRow(r, old?.key === 'closed')).join('')}</div>
      <button type="button" class="btn btn-sm" data-action="statuses.addReason">Add reason</button></fieldset>
    ${old?.key === 'closed' ? '<p>Spam stays available because it also blocks future emails from the contact.</p>' : ''}
    ${old && !STATUS_CATEGORIES.includes(old.key) ? `<label class="auth-check"><input id="status-retired" type="checkbox" ${!old.is_active ? 'checked' : ''}> Retired — hide from new selections</label>` : ''}
    <p id="status-error" role="alert"></p>`, async () => {
    if (busy || workspace !== getWorkspaceId() || jwt !== getJwt()) return;
    const error = document.getElementById('status-error');
    const label = document.getElementById('status-name').value.trim();
    if (!label) { error.textContent = 'Enter a status name.'; document.getElementById('status-name').focus(); return; }
    const reasons = readReasons();
    const reason_required = document.getElementById('status-reason-required').checked;
    if (reasons.length > 50 || reasons.some(r => !r.label) || new Set(reasons.filter(r => r.is_active).map(r => r.label.toLowerCase())).size !== reasons.filter(r => r.is_active).length || (reason_required && !reasons.some(r => r.is_active))) {
      error.textContent = 'Give each reason a unique name. Keep at least one available when a reason is required (maximum 50 reasons).'; return;
    }
    busy = true;
    const button = error.closest('.modal').querySelector('[data-action="modal.confirm"]');
    button.disabled = true; button.textContent = 'Saving…';
    try {
      const data = { label, send_survey: document.getElementById('status-survey').value === 'true', reason_required, reasons };
      if (old) await apiPut(`/api/v1/ticket-statuses/${old.key}`, { ...data, is_active: !document.getElementById('status-retired')?.checked });
      else await apiPost('/api/v1/ticket-statuses', { ...data, base_key: document.getElementById('status-category').value });
      if (workspace !== getWorkspaceId() || jwt !== getJwt()) return;
      await loadStatusOptions(true); closeModal(); renderPage('ticket-statuses'); showToast('Ticket status saved.');
    } catch (err) { if (workspace === getWorkspaceId() && error.isConnected) { error.textContent = err.message || 'Could not save this status. Try again.'; button.disabled = false; button.textContent = 'Save status'; } }
    finally { busy = false; }
  }, 'Save status');
  const modal = document.getElementById('status-name').closest('.modal');
  modal.classList.add('ticket-status-modal');
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', old ? 'Edit ticket status' : 'Add ticket status');
  modal.querySelector('.modal-close').outerHTML = '<button type="button" class="modal-close" data-action="modal.close" aria-label="Close dialog">×</button>';
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    if (event.key !== 'Tab') return;
    const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  const container = document.getElementById('modal-container');
  const observer = new MutationObserver(() => {
    if (!modal.isConnected) { observer.disconnect(); if (trigger?.isConnected) trigger.focus(); }
  });
  observer.observe(container, { childList: true });
  updateSurvey(); document.getElementById('status-name').focus();
}
function updateSurvey() {
  const category = document.getElementById('status-category'), survey = document.getElementById('status-survey');
  if (!category || !survey) return;
  survey.disabled = category.value !== 'resolved'; if (survey.disabled) survey.value = 'false';
  if (!category.disabled && category.value !== previousCategory) {
    const required = document.getElementById('status-reason-required');
    categoryDrafts.set(previousCategory, { required: required.checked, reasons: readReasons() });
    const next = categoryDrafts.get(category.value) || { required: category.value === 'closed', reasons: category.value === 'closed' ? DEFAULT_CLOSURE_REASONS : [] };
    document.getElementById('status-reasons').innerHTML = next.reasons.map(r => reasonRow(r)).join('');
    required.checked = next.required; previousCategory = category.value;
  }
}
function readReasons() {
  return [...document.querySelectorAll('#status-reasons [data-reason-key]')].map(row => ({ key: row.dataset.reasonKey, label: row.querySelector('input[type="text"]').value.trim(), is_active: !row.querySelector('input[type="checkbox"]').checked }));
}
function reasonRow(reason, builtinClosed = false) {
  const id = `reason-${reason.key}`, locked = builtinClosed && reason.key === 'spam';
  return `<div class="status-reason-row" data-reason-key="${window.escAttr(reason.key)}"><label class="stat-sr-only" for="${id}">Reason name</label><input type="text" class="form-input" id="${id}" maxlength="80" value="${window.escAttr(reason.label)}" ${reason.key === 'spam' ? 'disabled' : ''}>
    <label class="auth-check"><input type="checkbox" ${!reason.is_active ? 'checked' : ''} ${locked ? 'disabled' : ''}> Retired<span class="stat-sr-only"> ${window.escHtml(reason.label)}</span></label></div>`;
}
registerActions({ 'statuses.new': () => edit(), 'statuses.edit': ds => edit(ds.key), 'statuses.addReason': () => {
  const list = document.getElementById('status-reasons'); if (!list || list.children.length >= 50) return;
  list.insertAdjacentHTML('beforeend', reasonRow({ key: `reason-${crypto.randomUUID()}`, label: '', is_active: true })); list.lastElementChild.querySelector('input').focus();
}, 'statuses.reload': async () => { await loadStatusOptions(true); if (document.body.dataset.currentPage === 'ticket-statuses') renderPage('ticket-statuses'); } });
registerChangeActions({ 'statuses.category': updateSurvey });
