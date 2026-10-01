import { COMPOSE_TAB, SESSION } from '../core/state.js';
import { getWorkspaceId } from '../core/api-client.js';
import * as api from '../core/api-client.js';
import { TICKETS } from '../core/data.js';
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
const unavailable = new Set();
let revokedJwt;
let closed = false;
const deviceId = Math.random().toString(36).slice(2);
let revision = 0;
function cacheAllowed(id) {
  const jwt=api.getJwt?.();
  return (!closed || (SESSION?.userId && jwt && jwt!==revokedJwt)) &&
    !unavailable.has(getDraftPrefix(id)) && (!SESSION?.userId || (jwt && jwt !== revokedJwt));
}
function visible(s) { return s.loaded || s.edited; }

export function loadDraft(id, tab) {
  if (!cacheAllowed(id)) return '';
  const s=personalState(id,tab);
  return s ? (visible(s) ? s.local.body : '') : SESSION?.userId ? '' : (localStorage.getItem(getDraftKey(id,tab)) || '');
}

export function saveDraft(id, value, tab) {
  if (!cacheAllowed(id)) return;
  const key = getDraftKey(id, tab);
  const s = personalState(id,tab);
  if (loadDraft(id,tab) === (value || '')) return;
  if (value && value.length) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
  if (s) { s.local.body = value || ''; s.edited=true; }
  queuePersonalDraft(id, tab);
}

export function clearDraft(id, tab) {
  if (!cacheAllowed(id)) return;
  const s = personalState(id,tab);
  if ((tab || COMPOSE_TAB) === 'reply') cancelSharedSave(id);
  localStorage.removeItem(getDraftKey(id, tab));
  localStorage.removeItem(getDraftKey(id, tab) + ':ai-review');
  localStorage.removeItem(getDraftKey(id, tab) + ':email-recipients');
  localStorage.removeItem(getDraftKey(id, tab) + ':attachments');
  if (s) {s.local = {body:'',recipients:null,review:null,attachments:[]};s.edited=true;}
  queuePersonalDraft(id, tab);
}

export function loadDraftRecipients(id) {
  if (!cacheAllowed(id)) return null;
  const s = personalState(id,'reply');
  if (s) return visible(s) ? s.local.recipients : null;
  if (SESSION?.userId) return null;
  try {
    const value = JSON.parse(localStorage.getItem(getDraftKey(id, 'reply') + ':email-recipients') || 'null');
    return value && ['reply', 'reply_all'].includes(value.mode) && Array.isArray(value.to) && typeof value.cc === 'string' ? value : null;
  } catch { return null; }
}
export function saveDraftRecipients(id, value) {
  if (!cacheAllowed(id)) return;
  const s = personalState(id,'reply');
  const key = getDraftKey(id, 'reply') + ':email-recipients', json = JSON.stringify(value);
  if (JSON.stringify(loadDraftRecipients(id)) === json) return;
  localStorage.setItem(key, json);
  if (s) { s.local.recipients = value; s.edited=true; }
  queuePersonalDraft(id, 'reply');
}

export function loadDraftReview(id, tab) {
  if (!cacheAllowed(id)) return null;
  const s = personalState(id,tab);
  if (s) return visible(s) ? s.local.review : null;
  if (SESSION?.userId) return null;
  try {
    const value = JSON.parse(localStorage.getItem(getDraftKey(id, tab) + ':ai-review') || 'null');
    return value && Array.isArray(value.references) && Array.isArray(value.notes) ? value : null;
  } catch { return null; }
}

export function saveDraftReview(id, value, tab) {
  if (!cacheAllowed(id)) return;
  try {
    const s = personalState(id,tab);
    const key = getDraftKey(id, tab) + ':ai-review', json = JSON.stringify(value);
    if (JSON.stringify(loadDraftReview(id,tab)) === json) return;
    localStorage.setItem(key, json);
    if (s) { s.local.review = value; s.edited=true; }
    queuePersonalDraft(id, tab);
  } catch { /* The panel still shows for this render. */ }
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

export function textHtml(value) {
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
    saveDraftReview(id,{...review,...current,stale:shared.stale,sharedUpdatedBy:shared.updatedBy,sharedUpdatedAt:shared.updatedAt,
      sharedVersion:Math.max(current.sharedVersion??0,shared.version??0)},'reply');return;
  }
  if(!local && !localStorage.getItem(getDraftKey(id,'reply')+':sync')){saveDraft(id,body,'reply');saveDraftReview(id,{...review,confirmedUse:true,sharedAvailable:false},'reply');return;}
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
function cancelSharedSave(id) {
  const key=getDraftKey(id,'reply'),state=sharedSaves.get(key);
  if(state){clearTimeout(state.timer);state.cancelled=true;sharedSaves.delete(key);}
}

export function loadDraftAttachments(id) {
  if (!cacheAllowed(id)) return [];
  const s = personalState(id,'reply');
  if (s) return visible(s) ? s.local.attachments : [];
  if (SESSION?.userId) return [];
  try { const files=JSON.parse(localStorage.getItem(getDraftKey(id,'reply')+':attachments')); return Array.isArray(files)?files:[]; }
  catch { return []; }
}
export function saveDraftAttachments(id, files) {
  if (!cacheAllowed(id)) return;
  const s=personalState(id,'reply');
  if (s?.sending) throw Error('Wait for the reply to finish sending before changing attachments.');
  if (sameDraft(loadDraftAttachments(id),files)) return;
  localStorage.setItem(getDraftKey(id,'reply')+':attachments',JSON.stringify(files));
  if(s){s.local.attachments=files;s.edited=true;}
  queuePersonalDraft(id,'reply');
}
export function draftSending(id) { return !!personalState(id,'reply')?.sending; }
export function queueSharedAiDraftSave(id,ticketUuid,body,bodyHtml) {
  if (!cacheAllowed(id)) return;
  const review=loadDraftReview(id,'reply');
  if(!ticketUuid||!review?.suggestionId||review.rejected||review.sharedAvailable)return;
  const key=getDraftKey(id,'reply');
  if(sharedSaves.get(key)?.jwt!==api.getJwt?.())cancelSharedSave(id);
  const state=sharedSaves.get(key)||{id,key,jwt:api.getJwt?.()};
  state.latest={body,body_html:bodyHtml,version:review.sharedVersion||0,suggestion_id:review.suggestionId};
  clearTimeout(state.timer);state.timer=setTimeout(()=>flushSharedAiDraft(id,ticketUuid,state),700);sharedSaves.set(key,state);
}
async function flushSharedAiDraft(id,ticketUuid,state) {
  const active=()=>!state.cancelled&&state.key===getDraftKey(id,'reply')&&state.jwt===api.getJwt?.();
  if(!active()||state.saving||!state.latest)return;
  const payload=state.latest;state.latest=null;state.saving=true;
  try{
    const {apiPatch}=await import('../core/api-client.js');
    if(!active())return;
    const saved=await apiPatch(`/api/v1/tickets/${ticketUuid}/ai-draft`,payload);
    if(!active())return;
    const current=loadDraftReview(id,'reply');
    if(current?.suggestionId===payload.suggestion_id)saveDraftReview(id,{...current,edited:true,sharedVersion:saved.draft_version,
      sharedUpdatedAt:saved.draft_updated_at,sharedUpdatedBy:saved.draft_updated_by,sharedBody:payload.body_html||textHtml(payload.body)},'reply');
  }catch(error){
    const status=document.getElementById('draft-status-'+id);
    if(status&&active())status.textContent=error?.status===409?'Shared draft changed elsewhere. Reopen before continuing.':'Draft saved locally; sharing failed.';
  }finally{
    state.saving=false;if(state.latest&&active()){state.latest.version=loadDraftReview(id,'reply')?.sharedVersion||state.latest.version;void flushSharedAiDraft(id,ticketUuid,state);}
  }
}

// Remove EVERY tab's draft for a ticket (reply + internal note) — used when
// the ticket itself is deleted, where clearing only the active COMPOSE_TAB
// would leave the other tab's draft orphaned in localStorage forever.
export function clearAllDrafts(id) {
  cancelSharedSave(id);
  const prefix = getDraftPrefix(id);
  for (const [key, state] of personalSaves) if (key.startsWith(prefix)) {
    clearTimeout(state.timer); state.cancelled = true; personalSaves.delete(key);
  }
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) localStorage.removeItem(k);
  }
}

const personalSaves = new Map();
function syncMeta(id, tab) {
  const s = personalSaves.get(getDraftKey(id,tab));
  if (s && !s.cancelled && s.jwt === api.getJwt?.()) return s.meta;
  try { return JSON.parse(localStorage.getItem(getDraftKey(id, tab) + ':sync')) || { version: 0, dirty: false }; }
  catch { return { version: 0, dirty: true }; }
}
function setSyncMeta(s, value) {
  if (!current(s)) return;
  const cachedRevision=localStorage.getItem(s.key+':revision');
  if(!cachedRevision||cachedRevision===s.revision)localStorage.setItem(s.key + ':sync', JSON.stringify(value));
  // Separate dirty markers keep another tab's successful save from hiding our unsaved edits.
  if (value.dirty) localStorage.setItem(s.key + ':dirty:' + deviceId,s.revision);
  else {
    // A reloaded tab can finish saving the exact cached revision left by its predecessor.
    for(let i=localStorage.length-1;i>=0;i--){
      const key=localStorage.key(i);
      if(key?.startsWith(s.key+':dirty:')&&localStorage.getItem(key)===s.revision)localStorage.removeItem(key);
    }
  }
  s.meta = value; s.legacy = false;
}
export function draftSnapshot(id, tab = COMPOSE_TAB) {
  const s=personalState(id,tab);
  if (s) return {...s.local};
  return { body: loadDraft(id, tab), recipients: tab === 'reply' ? loadDraftRecipients(id) : null,
    review: tab === 'reply' ? loadDraftReview(id, tab) : null, attachments: tab === 'reply' ? loadDraftAttachments(id) : [] };
}
const sameDraft = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function personalState(id, tab = COMPOSE_TAB) {
  if (!cacheAllowed(id)) return null;
  const ticket = TICKETS.find(t => t.id === id);
  if (!ticket?._uuid || !SESSION?.userId || !api.getJwt?.()) return null;
  const key = getDraftKey(id, tab), jwt = api.getJwt();
  let s = personalSaves.get(key);
  if (!s || s.cancelled || s.jwt !== jwt) {
    if (s) { clearTimeout(s.timer); s.cancelled = true; }
    const json = suffix => { try { return JSON.parse(localStorage.getItem(key+suffix)); } catch { return null; } };
    const recipients = json(':email-recipients'), review = json(':ai-review');
    // Each open tab keeps its own copy/version; another tab's cache writes cannot rebase an edit silently.
    s = { id, tab, key, jwt, revision:localStorage.getItem(key+':revision')||deviceId+':'+(++revision), uuid: ticket._uuid, workspace: getWorkspaceId(), status: '', loaded: false,
      local: {body:localStorage.getItem(key)||'',
        recipients:tab==='reply' && recipients && ['reply','reply_all'].includes(recipients.mode) && Array.isArray(recipients.to) && typeof recipients.cc==='string' ? recipients : null,
        review:tab==='reply' && review && Array.isArray(review.references) && Array.isArray(review.notes) ? review : null,
        attachments:tab==='reply' && Array.isArray(json(':attachments')) ? json(':attachments') : []},
      meta:json(':sync')||{version:0,dirty:false}, legacy:!localStorage.getItem(key+':sync') };
    personalSaves.set(key, s);
  }
  return s;
}
function current(s) { return cacheAllowed(s.id) && !s.cancelled && s.key === getDraftKey(s.id, s.tab) && s.jwt === api.getJwt() && s.workspace === getWorkspaceId(); }
function status(s, text) {
  if (!current(s)) return;
  s.status = text;
  document.dispatchEvent(new CustomEvent('draft:status', { detail: { id: s.id, tab: s.tab } }));
}
export function draftSyncStatus(id, tab = COMPOSE_TAB) {
  if(!cacheAllowed(id))return 'Draft unavailable. This ticket may have been erased or your access changed.';
  const s = personalState(id, tab);
  return s?.status || (s ? (syncMeta(id, tab).dirty ? 'Saved locally; sync pending' : 'Checking saved draft…') : (loadDraft(id, tab) ? 'Saved locally' : ''));
}
export function draftHasConflict(id, tab = COMPOSE_TAB) { return !!personalState(id, tab)?.conflict; }
export function personalDraftReady(id, tab = COMPOSE_TAB) { const s = personalState(id, tab); return cacheAllowed(id) && (!s || s.loaded); }
function applyRemote(s, remote) {
  const before = draftSnapshot(s.id, s.tab);
  if (s.tab === 'reply') cancelSharedSave(s.id);
  localStorage.setItem(s.key, remote.body);
  for (const [suffix, value] of [[':email-recipients', remote.recipients], [':ai-review', remote.review], [':attachments',remote.attachments||[]]]) {
    if (value) localStorage.setItem(s.key + suffix, JSON.stringify(value));
    else localStorage.removeItem(s.key + suffix);
  }
  s.local = {body:remote.body,recipients:remote.recipients,review:remote.review,attachments:remote.attachments||[]};
  s.legacy = false;
  localStorage.setItem(s.key+':revision',s.revision);
  setSyncMeta(s, { version: remote.version, dirty: false });
  s.conflict = null;
  return !sameDraft(before, draftSnapshot(s.id, s.tab));
}
async function readRemote(s) {
  let draft;
  try { ({draft}=await api.apiGet(`/api/v1/tickets/${s.uuid}/drafts/${s.tab}`)); }
  catch(error) {
    if (current(s) && [403,404,410].includes(error?.status)) invalidateDraftTicket(s.id);
    throw error;
  }
  if (!current(s)) throw Error('Workspace changed');
  const wasLoaded=s.loaded;let changed=false;
  const meta = syncMeta(s.id, s.tab), local = draftSnapshot(s.id, s.tab);
  // Adopt old browser-only drafts only when no server version has ever existed.
  const legacy = s.legacy && !!(local.body || local.recipients || local.review || local.attachments.length);
  if ((meta.dirty || legacy) && (meta.version !== draft.version || (draft.version === 0 && !!draft.body))) {
    s.conflict = draft;
    status(s, 'Draft changed on another device. Review both copies.');
  } else if (meta.dirty || legacy) {
    setSyncMeta(s, { version: draft.version, dirty: true });
  } else {
    changed=applyRemote(s, draft);
    status(s, 'Synced');
  }
  s.loaded = true;
  if(!wasLoaded||changed)document.dispatchEvent(new CustomEvent('draft:restored', {detail:{id:s.id,tab:s.tab}}));
}
export async function refreshPersonalDraft(id, tab = COMPOSE_TAB) {
  const s = personalState(id, tab);
  if (!s || s.sending) return;
  if (s.saving) return s.saving.catch(() => {});
  if (s.loading) return s.loading;
  s.loading = readRemote(s).catch(() => status(s, 'Saved locally; sync unavailable')).finally(() => { s.loading = null; });
  await s.loading;
  if (current(s) && !s.conflict && syncMeta(id, tab).dirty) void flushPersonalDraft(id, tab).catch(() => {});
}
function queuePersonalDraft(id, tab = COMPOSE_TAB) {
  const s = personalState(id, tab);
  if (!s) return;
  s.revision=deviceId+':'+(++revision);
  localStorage.setItem(s.key+':revision',s.revision);
  setSyncMeta(s, { ...syncMeta(id, tab), dirty: true });
  status(s, s.conflict ? 'Draft changed on another device. Review both copies.' : 'Saved locally; sync pending');
  clearTimeout(s.timer);
  if (!s.sending) s.timer = setTimeout(() => { void flushPersonalDraft(id, tab).catch(() => {}); }, 700);
}
export async function flushPersonalDraft(id, tab = COMPOSE_TAB) {
  const s = personalState(id, tab);
  if (!s) return undefined;
  clearTimeout(s.timer);
  if (s.loading) await s.loading;
  if (s.saving) { await s.saving; return flushPersonalDraft(id, tab); }
  if (!current(s)) throw Error('Workspace changed');
  if (s.sending) throw Error('A message is being sent. Wait for it to finish.');
  const saving = (async () => {
    try {
      if (!s.loaded) await readRemote(s);
      if (s.conflict) throw Error('Draft changed on another device. Review both copies before continuing.');
      while (current(s)) {
        const meta = syncMeta(id, tab);
        // Establish a row before sending even if there was no previous draft.
        if (!meta.dirty && meta.version > 0) return meta.version;
        const sent = draftSnapshot(id, tab);
        status(s, 'Syncing…');
        const {attachments,...payload}=sent;
        const { draft } = await api.apiPut(`/api/v1/tickets/${s.uuid}/drafts/${tab}`, { ...payload, attachment_ids:attachments.map(a=>a.id), version: meta.version });
        if (!current(s)) throw Error('Workspace changed');
        setSyncMeta(s, { version: draft.version, dirty: !sameDraft(sent, draftSnapshot(id, tab)) });
        status(s, 'Synced');
      }
      throw Error('Workspace changed');
    } catch (error) {
      if (current(s) && [403,404,410].includes(error?.status)) invalidateDraftTicket(s.id);
      if (current(s) && error?.status === 409) await readRemote(s);
      status(s, s.conflict ? 'Draft changed on another device. Review both copies.' : 'Saved locally; sync unavailable');
      throw error;
    }
  })();
  s.saving = saving;
  try { return await saving; } finally { if (s.saving === saving) s.saving = null; }
}
export function conflictingDraft(id, tab = COMPOSE_TAB) { return personalState(id, tab)?.conflict; }
export async function resolvePersonalDraft(id, tab, useLocal) {
  const s = personalState(id, tab);
  if (!s?.conflict) return;
  if (useLocal) {
    setSyncMeta(s, { version: s.conflict.version, dirty: true });
    s.conflict = null;
    await flushPersonalDraft(id, tab);
  } else {
    applyRemote(s, s.conflict);
    status(s, 'Synced');
    document.dispatchEvent(new CustomEvent('draft:restored', { detail: { id, tab } }));
  }
}
export async function prepareDraftSend(id, tab = COMPOSE_TAB) {
  const version = await flushPersonalDraft(id, tab);
  const s = personalState(id, tab);
  if (s) { s.sending = true; clearTimeout(s.timer); }
  return { version, snapshot: draftSnapshot(id, tab), scope: s };
}
export function finishDraftSend(id, tab, sent, version) {
  const s = sent.scope || personalState(id, tab);
  if (!s) return !sent.scope;
  s.sending = false;
  if (s !== sent.scope || !current(s)) return false;
  if (version === undefined) { queuePersonalDraft(id, tab); return false; }
  const unchanged = sameDraft(sent.snapshot, draftSnapshot(id, tab));
  if (tab === 'reply') cancelSharedSave(id);
  // These files now belong to the sent message, even if new text was typed during sending.
  if (tab === 'reply') { s.local.attachments=[]; localStorage.removeItem(s.key+':attachments'); }
  if (unchanged) applyRemote(s, { body: '', recipients: null, review: null, version });
  else { setSyncMeta(s, { version, dirty: true }); queuePersonalDraft(id, tab); }
  status(s, unchanged ? 'Synced' : 'Saved locally; sync pending');
  return unchanged;
}

export function retryPersonalDrafts() {
  for (const s of personalSaves.values()) if (current(s) && syncMeta(s.id,s.tab).dirty) void refreshPersonalDraft(s.id,s.tab);
}

function removeCachedDrafts(matches) {
  for (const states of [personalSaves,sharedSaves]) for (const [key,s] of states) if (matches(key)) {
    clearTimeout(s.timer);s.cancelled=true;s.local=null;s.latest=null;s.conflict=null;states.delete(key);
  }
  for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key&&matches(key))localStorage.removeItem(key);}
}
export function clearBrowserDrafts(userId, broadcast=true) {
  if (!userId) return;
  if (SESSION?.userId===userId) {revokedJwt=api.getJwt?.();closed=true;}
  removeCachedDrafts(key => key.startsWith('draft:') && (!key.startsWith('draft:v2:') || key.split(':')[3]===userId));
  document.dispatchEvent(new CustomEvent('draft:cleared',{detail:{userId}}));
  if (broadcast) localStorage.setItem('respovia:draft-signout:'+userId,Date.now()+':'+deviceId);
}
export function invalidateDraftTicket(id, broadcast=true, workspace=getWorkspaceId(), userId=SESSION?.userId) {
  const matches=key=>key.startsWith('draft:v2:'+workspace+':')&&key.split(':')[4]===id&&(!userId||key.split(':')[3]===userId);
  removeCachedDrafts(matches);
  if (workspace===getWorkspaceId()&&(!userId||userId===SESSION?.userId)) {
    unavailable.add(getDraftPrefix(id));
    document.dispatchEvent(new CustomEvent('draft:cleared',{detail:{id}}));
  }
  if(broadcast)localStorage.setItem('respovia:draft-erased',JSON.stringify({workspace,id,userId,nonce:Date.now()+':'+deviceId}));
}
export async function flushBrowserDrafts() {
  // Materialise cached drafts in this workspace, including tickets not opened this visit.
  for(const ticket of TICKETS) for(const tab of ['reply','note']) {
    const key=getDraftKey(ticket.id,tab);
    if(['',':sync',':attachments',':email-recipients',':ai-review'].some(suffix=>localStorage.getItem(key+suffix)))personalState(ticket.id,tab);
  }
  for(const s of [...personalSaves.values()]) if(current(s)) {
    if(s.sending)throw Error('A reply is still being sent.');
    if(s.meta.dirty||s.legacy||s.saving)await flushPersonalDraft(s.id,s.tab);
  }
  // Other tabs have independent versions. Their dirty markers survive our successful saves.
  for(let i=0;i<localStorage.length;i++) {
    const key=localStorage.key(i);
    if(key?.startsWith('draft:')&&!key.startsWith('draft:v2:'))throw Error('An older browser draft has not been saved.');
    if(!key?.startsWith('draft:v2:')||key.split(':')[3]!==SESSION?.userId)continue;
    if(key.includes(':dirty:'))throw Error('Another tab has unsaved drafts.');
    if(key.endsWith(':sync')&&JSON.parse(localStorage.getItem(key)||'{}').dirty)throw Error('Another tab or workspace has unsaved drafts.');
    const base=key.split(':').slice(0,6).join(':');
    if(/:(reply|note)(:(attachments|email-recipients|ai-review))?$/.test(key)&&localStorage.getItem(key)&&!localStorage.getItem(base+':sync'))throw Error('A browser draft has not been saved.');
  }
}
window.addEventListener?.('respovia:clear-drafts',event=>clearBrowserDrafts(event.detail?.userId,event.detail?.broadcast!==false));
window.addEventListener?.('storage',event=>{
  if(event.key?.startsWith('respovia:draft-signout:')) {
    const userId=event.key.slice('respovia:draft-signout:'.length);
    clearBrowserDrafts(userId,false);
    if(SESSION?.userId===userId)window.dispatchEvent(new CustomEvent('respovia:session-expired',{detail:{remote:true}}));
  }
  if(event.key==='respovia:draft-erased'&&event.newValue) {
    try{const {id,workspace,userId}=JSON.parse(event.newValue);if(typeof id==='string'&&typeof workspace==='string')invalidateDraftTicket(id,false,workspace,userId);}catch{}
  }
});
window.addEventListener?.('respovia:auth-scope-changed',()=>{
  unavailable.clear();
  for(const s of personalSaves.values())if(!current(s)){clearTimeout(s.timer);s.cancelled=true;}
  for(const s of sharedSaves.values())if(s.key!==getDraftKey(s.id,'reply')||s.jwt!==api.getJwt?.()){clearTimeout(s.timer);s.cancelled=true;}
});
window.addEventListener?.('respovia:customer-erased',event=>{
  for(const ticket of TICKETS)if(ticket.customerId===event.detail?.id)invalidateDraftTicket(ticket.id,true,getWorkspaceId(),null);
});
