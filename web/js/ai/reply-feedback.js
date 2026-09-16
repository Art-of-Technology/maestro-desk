import { apiPost, getWorkspaceId, getJwt } from '../core/api-client.js';
import { COMPOSE_TAB } from '../core/state.js';
import { loadDraftReview, saveDraftReview } from '../tickets/drafts.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';

export const FEEDBACK_REASONS = { wrong_match: 'Wrong match', outdated_advice: 'Outdated advice', wrong_language: 'Wrong language', other: 'Other' };
const pending = new Set();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function renderReplyFeedback(id, review) {
  if (!uuid.test(review?.suggestionId || '')) return '';
  const selected = review.feedback;
  return `<div class="reply-feedback" data-suggestion-id="${review.suggestionId}">
    <p>Was this suggestion helpful?</p>
    <div class="reply-feedback-controls">${[true, false].map(helpful => `<button type="button" class="btn btn-ghost" data-action="replyFeedback.rate" data-ticket-id="${window.escAttr(id)}" data-helpful="${helpful}" aria-pressed="${selected?.helpful === helpful}">${helpful ? 'Helpful' : 'Not helpful'}</button>`).join('')}
    <label>Reason (optional)<select class="form-select" data-feedback-reason><option value="">Choose a reason</option>${Object.entries(FEEDBACK_REASONS).map(([key,label]) => `<option value="${key}" ${selected?.reason === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
    <p class="reply-feedback-status" role="status">${selected ? 'Feedback saved. Choose a rating again to update it.' : 'Feedback is for your team and won’t change your draft.'}</p>
    ${COMPOSE_TAB === 'reply' ? `<label class="reply-use-confirm"><input type="checkbox" data-change-action="replyFeedback.confirmUse" data-ticket-id="${window.escAttr(id)}" ${review.confirmedUse ? 'checked' : ''}>This reply uses the suggestion (for reporting)</label>` : ''}
  </div>`;
}

export async function rateReply(ds, button) {
  const panel = button.closest('.reply-feedback');
  const tab = COMPOSE_TAB, workspace = getWorkspaceId(), jwt = getJwt();
  const review = loadDraftReview(ds.ticketId, tab);
  if (!panel || review?.suggestionId !== panel.dataset.suggestionId || !workspace || !jwt) return;
  const key = `${workspace}:${jwt}:${review.suggestionId}`;
  if (pending.has(key)) return;
  const helpful = ds.helpful === 'true';
  const reason = helpful ? null : panel.querySelector('[data-feedback-reason]').value || null;
  const status = panel.querySelector('[role="status"]');
  pending.add(key);
  panel.querySelectorAll('button,select').forEach(el => { el.disabled = true; });
  status.textContent = 'Saving feedback…';
  const sameScope = () => workspace === getWorkspaceId() && jwt === getJwt();
  const samePanel = () => sameScope() && panel.isConnected && tab === COMPOSE_TAB
    && loadDraftReview(ds.ticketId, tab)?.suggestionId === review.suggestionId;
  try {
    const feedback = await apiPost(`/api/v1/ai/reply-feedback/${review.suggestionId}`, { helpful, reason });
    if (!sameScope()) return;
    const current = loadDraftReview(ds.ticketId, tab);
    if (current?.suggestionId === review.suggestionId) saveDraftReview(ds.ticketId, { ...current, feedback }, tab);
    if (samePanel()) {
      if (helpful) panel.querySelector('[data-feedback-reason]').value = '';
      panel.querySelectorAll('button').forEach(el => el.setAttribute('aria-pressed', String((el.dataset.helpful === 'true') === helpful)));
      status.textContent = 'Feedback saved. Choose a rating again to update it.';
    }
  } catch {
    if (samePanel()) status.textContent = 'Feedback wasn’t saved. Try again.';
  } finally {
    pending.delete(key);
    if (samePanel()) panel.querySelectorAll('button,select').forEach(el => { el.disabled = false; });
  }
}
registerActions({ 'replyFeedback.rate': rateReply });
registerChangeActions({ 'replyFeedback.confirmUse': (ds, el) => {
  const review = loadDraftReview(ds.ticketId);
  if (review?.suggestionId === el.closest('.reply-feedback')?.dataset.suggestionId)
    saveDraftReview(ds.ticketId, { ...review, confirmedUse: el.checked });
} });
