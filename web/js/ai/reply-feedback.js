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
    <label>Reason (optional)<select class="form-select" data-feedback-reason data-change-action="replyFeedback.reason" data-ticket-id="${window.escAttr(id)}"><option value="">Choose a reason</option>${Object.entries(FEEDBACK_REASONS).map(([key,label]) => `<option value="${key}" ${selected?.reason === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
    <p class="reply-feedback-status" role="status">${selected ? 'Feedback saved.' : 'Feedback is for your team and won’t change your draft.'}</p>
    ${COMPOSE_TAB === 'reply' ? `<label class="reply-use-confirm"><input type="checkbox" data-change-action="replyFeedback.confirmUse" data-ticket-id="${window.escAttr(id)}" ${review.confirmedUse ? 'checked' : ''} ${review.rejected?'disabled':''}>This reply uses the suggestion (for reporting)</label>
      <button type="button" class="btn btn-ghost" data-action="replyFeedback.reject" data-ticket-id="${window.escAttr(id)}" data-rejected="${!review.rejected}" aria-pressed="${!!review.rejected}">${review.rejected?'Undo rejection':'Reject suggestion (for reporting)'}</button>` : ''}
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
      panel.querySelectorAll('button').forEach(el => { if(el.dataset.helpful!==undefined)el.setAttribute('aria-pressed', String((el.dataset.helpful === 'true') === helpful)); });
      status.textContent = 'Feedback saved.';
    }
  } catch {
    if (samePanel()) status.textContent = `Feedback wasn’t saved. Click ${helpful ? 'Helpful' : 'Not helpful'} to retry.`;
  } finally {
    pending.delete(key);
    if (samePanel()) panel.querySelectorAll('button,select').forEach(el => { el.disabled = false; });
  }
}
export async function changeReplyReason(ds, select) {
  const panel = select.closest('.reply-feedback');
  const review = loadDraftReview(ds.ticketId);
  if (!panel?.isConnected || select.disabled || review?.suggestionId !== panel.dataset.suggestionId) return;
  if (review.feedback?.helpful !== false) {
    panel.querySelector('[role="status"]').textContent = 'Reason not saved. Choose Not helpful to submit it.';
    return;
  }
  await rateReply({ ...ds, helpful: 'false' }, select);
}
export async function rejectReply(ds,button) {
  const panel=button.closest('.reply-feedback'),tab=COMPOSE_TAB,workspace=getWorkspaceId(),jwt=getJwt();
  const review=loadDraftReview(ds.ticketId,tab);
  if(tab!=='reply'||!panel||!workspace||!jwt||review?.suggestionId!==panel.dataset.suggestionId)return;
  const key=`${workspace}:${jwt}:${review.suggestionId}`;
  if(pending.has(key))return;
  const active=()=>workspace===getWorkspaceId()&&jwt===getJwt()&&tab===COMPOSE_TAB&&panel.isConnected
    &&loadDraftReview(ds.ticketId,tab)?.suggestionId===review.suggestionId;
  const status=panel.querySelector('[role="status"]');
  pending.add(key);panel.querySelectorAll('button,select').forEach(el=>{el.disabled=true;});
  status.textContent='Saving choice…';
  try {
    const result=await apiPost(`/api/v1/ai/reply-feedback/${review.suggestionId}/rejected`,{rejected:ds.rejected==='true'});
    if(workspace!==getWorkspaceId()||jwt!==getJwt())return;
    const current=loadDraftReview(ds.ticketId,tab);
    if(current?.suggestionId!==review.suggestionId)return;
    saveDraftReview(ds.ticketId,{...current,rejected:result.rejected,...(result.rejected?{confirmedUse:false}:{})},tab);
    if(!active())return;
    button.dataset.rejected=String(!result.rejected);button.setAttribute('aria-pressed',String(result.rejected));
    button.textContent=result.rejected?'Undo rejection':'Reject suggestion (for reporting)';
    const use=panel.querySelector('[data-change-action="replyFeedback.confirmUse"]');
    if(use){use.disabled=result.rejected;if(result.rejected)use.checked=false;}
    status.textContent=result.rejected?'Rejection recorded. Your draft has been kept.':'Rejection removed.';
  } catch {if(active())status.textContent='Your choice was not saved. Try again.';}
  finally {pending.delete(key);if(active())panel.querySelectorAll('button,select').forEach(el=>{el.disabled=false;});}
}
registerActions({ 'replyFeedback.rate': rateReply, 'replyFeedback.reject':rejectReply });
registerChangeActions({ 'replyFeedback.reason': changeReplyReason, 'replyFeedback.confirmUse': (ds, el) => {
  const review = loadDraftReview(ds.ticketId);
  if (!review?.rejected && review?.suggestionId === el.closest('.reply-feedback')?.dataset.suggestionId)
    saveDraftReview(ds.ticketId, { ...review, confirmedUse: el.checked });
} });
