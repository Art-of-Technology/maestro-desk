import { apiGet, apiPatch, getWorkspaceId, getJwt } from '../core/api-client.js';
import { registerActions, registerChangeActions } from '../core/event-delegation.js';
import { FEEDBACK_REASONS } from '../ai/reply-feedback.js';
import { formatRoute } from '../core/route-location.js';
const statuses={open:'Open',in_progress:'In progress',resolved:'Resolved'};
const causes={knowledge_gap:'Missing knowledge',outdated_knowledge:'Outdated knowledge',wrong_match:'Wrong example matched',language:'Language problem',generation:'Generated reply problem',other:'Other'};
const esc=value=>window.escHtml(String(value??''));
const attr=value=>window.escAttr(String(value??''));
const options=(items,value)=>Object.entries(items).map(([key,label])=>`<option value="${attr(key)}" ${key===value?'selected':''}>${esc(label)}</option>`).join('');
const scope=()=>JSON.stringify([getWorkspaceId(),getJwt()]);

function resolutionForm(item,owners) {
  const unavailable=item.owner_user_id && !owners.some(owner=>owner.id===item.owner_user_id);
  return `<p><strong>${esc(statuses[item.resolution_status]||'Open')}</strong> · Owner: ${esc(item.owner_name||(item.owner_user_id?'Unavailable member':'Unassigned'))}${item.root_cause?` · Cause: ${esc(causes[item.root_cause])}`:''}</p>
    ${item.resolution_notes?`<p class="reply-feedback-text">${esc(item.resolution_notes)}</p>`:''}
    ${item.resolution_updated_at?`<p>Resolution last updated ${esc(new Date(item.resolution_updated_at).toLocaleString())}.</p>`:''}
    <details><summary>Manage resolution</summary><div class="form-grid" style="margin-top:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))">
      <label class="form-row">Status<select class="form-input" name="status">${options(statuses,item.resolution_status||'open')}</select></label>
      <label class="form-row">Owner<select class="form-input" name="owner"><option value="">Unassigned</option>${unavailable?`<option value="${attr(item.owner_user_id)}" selected disabled>Previous owner unavailable — choose another</option>`:''}${owners.map(owner=>`<option value="${attr(owner.id)}" ${owner.id===item.owner_user_id?'selected':''}>${esc(owner.name)}</option>`).join('')}</select></label>
      <label class="form-row">Cause<select class="form-input" name="cause"><option value="">Not identified</option>${options(causes,item.root_cause)}</select></label>
    </div><label class="form-row">Resolution notes<textarea class="form-input" name="notes" maxlength="2000" rows="3">${esc(item.resolution_notes)}</textarea></label>
    <p>Record the cause and what was changed before marking this resolved. This does not change articles or train the AI.</p>
    <button class="btn btn-solid" data-action="replyFeedback.save">Save resolution</button><p role="status" class="resolution-status"></p></details>`;
}

export function settingsReplyFeedback() {
  if (!window.isAdmin()) return '<p>Admin permission is required to review feedback.</p>';
  setTimeout(() => loadReplyFeedback(0), 0);
  return '<h2 class="settings-h">Reply feedback</h2><p>Review suggestions agents marked Not helpful. Ratings help your team spot problems; they don’t automatically change future replies.</p><button type="button" class="btn" data-action="reports.openAi">View AI reply performance report</button><div id="reply-feedback-list" aria-live="polite"><p>Loading feedback…</p></div>';
}

export async function loadReplyFeedback(offset = 0) {
  const host = document.getElementById('reply-feedback-list');
  if (!host || !window.isAdmin()) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  const filter=document.getElementById('reply-feedback-filter')?.value || host.dataset.filter || 'open';
  host.dataset.scope=scope(); host.dataset.offset=String(offset); host.dataset.filter=filter;
  const request = String(Number(host.dataset.request || 0) + 1);
  host.dataset.request = request;
  const active = () => host.isConnected && host === document.getElementById('reply-feedback-list')
    && host.dataset.request === request && workspace === getWorkspaceId() && jwt === getJwt() && window.isAdmin();
  const pageButton = (label, page) => `<button type="button" class="btn btn-ghost" data-action="replyFeedback.page" data-offset="${page}">${label}</button>`;
  host.innerHTML = '<p>Loading feedback…</p>';
  try {
    const data = await apiGet(`/api/v1/ai/reply-feedback?offset=${offset}&status=${encodeURIComponent(filter)}`);
    if (!active()) return;
    const link = t => `<a href="${window.escAttr(formatRoute({workspaceId:workspace,page:'tickets',entityId:t.id}))}">${window.escHtml(t.display_id)} · ${window.escHtml(t.subject)}</a>`;
    host.innerHTML = `<div class="reply-feedback-controls"><label>Resolution status <select id="reply-feedback-filter" class="form-input" data-change-action="replyFeedback.filter">${options({...statuses,all:'All statuses'},filter)}</select></label>${pageButton('Refresh', offset)}${offset ? pageButton('Previous', Math.max(0,offset-25)) : ''}${data.hasMore && offset < 10000 ? pageButton('Next',offset+25) : ''}</div>` +
      (data.items.length ? data.items.map(item => `<article class="reply-feedback-card" data-id="${attr(item.id)}" data-version="${item.resolution_version||0}"><h3>${link({id:item.ticket_id,display_id:item.display_id,subject:item.subject})}</h3>
        <p><strong>${FEEDBACK_REASONS[item.reason] || 'No reason given'}</strong> · ${window.escHtml(new Date(item.updated_at).toLocaleString())}</p>
        <p class="reply-feedback-text">${window.escHtml(item.reply)}</p>
        <p>Original suggestion. The agent may have edited it before sending.</p>
        <details><summary>Previous tickets used as examples (${item.sources.length})</summary>${item.sources.length ? `<ul>${item.sources.map(t => `<li>${link(t)}</li>`).join('')}</ul>` : '<p>No previous ticket examples were used.</p>'}</details>${resolutionForm(item,data.owners||[])}</article>`).join('')
        : '<p>No suggestions marked Not helpful on this page.</p>');
  } catch {
    if (active()) host.innerHTML = `<p>Feedback couldn’t be loaded. Try again.</p>${pageButton('Try again',offset)}`;
  }
}
export async function saveFeedbackResolution(_ds,button) {
  const card=button.closest('.reply-feedback-card'),host=document.getElementById('reply-feedback-list');
  if(!card||!host||host.dataset.scope!==scope()||!window.isAdmin()||button.disabled)return;
  const request=host.dataset.request, captured=scope();
  const active=()=>card.isConnected && host===document.getElementById('reply-feedback-list') && captured===scope() && request===host.dataset.request && window.isAdmin();
  const field=name=>card.querySelector(`[name="${name}"]`);
  const message=card.querySelector('.resolution-status');
  const controls=[...card.querySelectorAll('input,select,textarea,button')];
  const body={status:field('status').value,owner_user_id:field('owner').value||null,root_cause:field('cause').value||null,notes:field('notes').value.trim(),version:Number(card.dataset.version)};
  if(body.status==='resolved'&&(!body.root_cause||!body.notes)){message.textContent='Add a cause and resolution notes before resolving this feedback.';return;}
  controls.forEach(el=>{el.disabled=true;});message.textContent='Saving…';
  try {
    await apiPatch(`/api/v1/ai/reply-feedback/${encodeURIComponent(card.dataset.id)}/resolution`,body);
    if(active())await loadReplyFeedback(Number(host.dataset.offset)||0);
  } catch(error) {
    if(active())message.textContent=error?.status===409?'This feedback changed. Copy your notes, then refresh before saving.':'The resolution was not saved. Check the owner is active and try again.';
  } finally { if(active())controls.forEach(el=>{el.disabled=false;}); }
}
registerActions({ 'replyFeedback.page': ds => loadReplyFeedback(Number(ds.offset) || 0), 'replyFeedback.save':saveFeedbackResolution });
registerChangeActions({ 'replyFeedback.filter':()=>loadReplyFeedback(0) });
