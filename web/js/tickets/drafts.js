import { COMPOSE_TAB, SESSION } from '../core/state.js';
import { getWorkspaceId } from '../core/api-client.js';
// ─── Composer drafts ─────────────────────────────────────────────────────────
// Persist the composer textarea's content to localStorage per (ticket, tab)
// so an agent can switch tickets mid-draft without losing work. The key
// embeds COMPOSE_TAB so a partial reply and a partial internal note on the
// same ticket coexist independently.
//
// COMPOSE_TAB is imported from core/state.js.

// The tab is an explicit parameter defaulting to the live COMPOSE_TAB, so a
// caller that knows which tab it means (the new-ticket flow always writes a
// customer-facing 'reply' draft) doesn't have to move the app-wide global to
// address the right key.
// Display numbers repeat across workspaces; browsers can also be shared by
// agents. Legacy unscoped drafts cannot safely be attributed to either, so
// leave them stored without automatically attaching them to a conversation.
function getDraftPrefix(id) {
  return `draft:v2:${getWorkspaceId() || 'demo'}:${SESSION?.userId || 'demo'}:${id}:`;
}
function getDraftKey(id, tab = COMPOSE_TAB) { return getDraftPrefix(id) + tab; }

export function loadDraft(id, tab)   { return localStorage.getItem(getDraftKey(id, tab)) || ''; }

export function saveDraft(id, value, tab) {
  const key = getDraftKey(id, tab);
  if (value && value.length) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

export function clearDraft(id, tab) {
  localStorage.removeItem(getDraftKey(id, tab));
  localStorage.removeItem(getDraftKey(id, tab) + ':ai-review');
}

export function loadDraftReview(id, tab) {
  try {
    const value = JSON.parse(localStorage.getItem(getDraftKey(id, tab) + ':ai-review') || 'null');
    return value && Array.isArray(value.references) && Array.isArray(value.notes) ? value : null;
  } catch { return null; }
}

export function saveDraftReview(id, value, tab) {
  try { localStorage.setItem(getDraftKey(id, tab) + ':ai-review', JSON.stringify(value)); } catch { /* The panel still shows for this render. */ }
}

// Feedback belongs to the suggestion, not the message sent to the customer.
export function loadMessageReview(id, tab) {
  const review = loadDraftReview(id, tab);
  return review && !review.sharedAvailable && !review.rejected ? { references: review.references, notes: review.notes } : undefined;
}

export function confirmedReplySuggestion(id, tab = COMPOSE_TAB) {
  const review = loadDraftReview(id, tab);
  return tab === 'reply' && !review?.rejected && !review?.sharedAvailable && review?.confirmedUse === true ? review.suggestionId : undefined;
}

function textHtml(value) {
  return String(value || '').split(/\r?\n/).map(line => `<p>${line ? window.escHtml(line) : '<br>'}</p>`).join('');
}

export function hydrateSharedAiDraft(id, shared) {
  if (!shared?.suggestionId) return;
  const local=loadDraft(id,'reply'),current=loadDraftReview(id,'reply');
  const body=shared.isHtml?shared.body:textHtml(shared.body);
  const review={...(shared.review||{references:[],notes:[]}),suggestionId:shared.suggestionId,
    ...(shared.feedback?{feedback:shared.feedback}:{}),rejected:shared.rejected,stale:shared.stale,
    sharedBody:body,sharedIsHtml:true,sharedVersion:shared.version,sharedUpdatedBy:shared.updatedBy,
    sharedUpdatedAt:shared.updatedAt};
  if(shared.rejected){
    if(current?.suggestionId===shared.suggestionId)saveDraft(id,'','reply');
    saveDraftReview(id,{...review,sharedAvailable:false},'reply');return;
  }
  if(current?.suggestionId===shared.suggestionId&&(local===body||(current.sharedVersion??-1)>=shared.version)){
    saveDraftReview(id,{...review,...current,stale:shared.stale,sharedUpdatedBy:shared.updatedBy,sharedUpdatedAt:shared.updatedAt},'reply');return;
  }
  if(!local){saveDraft(id,body,'reply');saveDraftReview(id,{...review,confirmedUse:true,sharedAvailable:false},'reply');return;}
  saveDraftReview(id,{...review,sharedAvailable:true},'reply');
}

export function activateSharedAiDraft(id) {
  const review=loadDraftReview(id,'reply');
  if(!review?.sharedBody)return null;
  saveDraft(id,review.sharedBody,'reply');
  saveDraftReview(id,{...review,sharedAvailable:false,confirmedUse:true},'reply');
  return review.sharedBody;
}

const sharedSaves=new Map();
export function queueSharedAiDraftSave(id,ticketUuid,body,bodyHtml) {
  const review=loadDraftReview(id,'reply');
  if(!ticketUuid||!review?.suggestionId||review.rejected||review.sharedAvailable)return;
  const state=sharedSaves.get(id)||{};
  state.latest={body,body_html:bodyHtml,version:review.sharedVersion||0,suggestion_id:review.suggestionId};
  clearTimeout(state.timer);state.timer=setTimeout(()=>flushSharedAiDraft(id,ticketUuid),700);sharedSaves.set(id,state);
}
async function flushSharedAiDraft(id,ticketUuid) {
  const state=sharedSaves.get(id);if(!state||state.saving||!state.latest)return;
  const payload=state.latest;state.latest=null;state.saving=true;
  try{
    const {apiPatch}=await import('../core/api-client.js');
    const saved=await apiPatch(`/api/v1/tickets/${ticketUuid}/ai-draft`,payload);
    const current=loadDraftReview(id,'reply');
    if(current?.suggestionId===payload.suggestion_id)saveDraftReview(id,{...current,edited:true,sharedVersion:saved.draft_version,
      sharedUpdatedAt:saved.draft_updated_at,sharedUpdatedBy:saved.draft_updated_by,sharedBody:payload.body_html||textHtml(payload.body)},'reply');
  }catch(error){
    const status=document.getElementById('draft-status-'+id);
    if(status)status.textContent=error?.status===409?'Shared draft changed elsewhere. Reopen before continuing.':'Draft saved locally; sharing failed.';
  }finally{
    state.saving=false;if(state.latest){state.latest.version=loadDraftReview(id,'reply')?.sharedVersion||state.latest.version;void flushSharedAiDraft(id,ticketUuid);}
  }
}

// Remove EVERY tab's draft for a ticket (reply + internal note) — used when
// the ticket itself is deleted, where clearing only the active COMPOSE_TAB
// would leave the other tab's draft orphaned in localStorage forever.
export function clearAllDrafts(id) {
  const prefix = getDraftPrefix(id);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) localStorage.removeItem(k);
  }
}
