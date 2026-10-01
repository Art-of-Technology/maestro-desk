// Pending uploads are part of the agent's versioned reply draft.
import { TICKETS } from '../core/data.js';
import { COMPOSE_TAB } from '../core/state.js';
import { registerActions } from '../core/event-delegation.js';
import { apiUpload, getWorkspaceId, getJwt } from '../core/api-client.js';
import { showToast } from '../core/toast.js';
import { fmtBytes } from './attachment-chips.js';
import { loadDraftAttachments, saveDraftAttachments, flushPersonalDraft, draftSending } from './drafts.js';

const uploads = new Map();
const scopeKey = id => `${getWorkspaceId()}:${getJwt()}:${id}`;
export const pendingAttachments = id => loadDraftAttachments(id);
export const pendingAttachmentIds = id => pendingAttachments(id).map(a=>a.id);
export const attachmentsUploading = id => (uploads.get(scopeKey(id)) || 0)>0;

export function renderPendingAttachments(id) {
  const host=document.getElementById('pending-att-'+id);
  if (!host || typeof host.innerHTML!=='string') return;
  const list=pendingAttachments(id), uuid=TICKETS.find(t=>t.id===id)?._uuid;
  const hint=document.querySelector?.(`#ticket-page-${id} .composer-launch-hint`);
  if(hint)hint.textContent=attachmentsUploading(id)?'Uploading files…':list.length?`${list.length} ${list.length===1?'attachment':'attachments'} ready`:'';
  host.innerHTML=list.map(a=>`<span class="att-chip att-chip-pending">
    <button type="button" class="att-preview-button" data-action="att.preview" data-ticket-uuid="${window.escAttr(uuid||'')}" data-att-id="${window.escAttr(a.id)}" data-filename="${window.escAttr(a.filename)}">${window.escHtml(a.filename)} <span class="att-size">${fmtBytes(a.size_bytes)}</span></button>
    <button type="button" class="att-chip-x" title="Remove attachment" aria-label="Remove ${window.escAttr(a.filename)}" data-action="att.remove" data-id="${window.escAttr(id)}" data-att-id="${window.escAttr(a.id)}">×</button></span>`).join('');
}

export async function uploadFiles(id,files) {
  const uuid=TICKETS.find(t=>t.id===id)?._uuid;
  if(!uuid){showToast('Attachments need a saved ticket.','warn');return;}
  if(draftSending(id)){showToast('Wait for the reply to finish sending.','warn');return;}
  const scope=scopeKey(id);
  uploads.set(scope,(uploads.get(scope)||0)+1);renderPendingAttachments(id);
  try {
    for(const file of files){
      if(scope!==scopeKey(id))return;
      if(pendingAttachments(id).length>=20){showToast('A reply can have up to 20 attached files.','warn');break;}
      const form=new FormData();form.append('file',file,file.name);
      try {
        const res=await apiUpload(`/api/v1/tickets/${uuid}/attachments`,form);
        if(scope!==scopeKey(id))return;
        saveDraftAttachments(id,[...pendingAttachments(id),res.attachment]);renderPendingAttachments(id);
        try {await flushPersonalDraft(id,'reply');}
        catch {showToast('File uploaded. The draft has not synced yet; check its status before leaving.','warn');}
      } catch(error){if(scope===scopeKey(id))showToast(`Could not attach ${file.name}: ${error.message}`,'error');}
    }
  } finally {
    const remaining=(uploads.get(scope)||1)-1;
    if(remaining)uploads.set(scope,remaining);else uploads.delete(scope);
    if(scope===scopeKey(id))renderPendingAttachments(id);
  }
}

export function showAttachPanel(id) {
  if(COMPOSE_TAB!=='reply'){showToast('Attach files to a reply.','warn');return;}
  if(typeof document.createElement!=='function')return;
  const scope=scopeKey(id),input=document.createElement('input');input.type='file';input.multiple=true;input.style.display='none';
  input.addEventListener('change',()=>{const files=[...(input.files||[])];input.remove();if(files.length&&scope===scopeKey(id))void uploadFiles(id,files);});
  input.addEventListener('cancel',()=>input.remove());document.body.appendChild(input);input.click();
}

registerActions({'att.remove':ds=>{
  try {saveDraftAttachments(ds.id,pendingAttachments(ds.id).filter(a=>a.id!==ds.attId));renderPendingAttachments(ds.id);}
  catch(error){showToast(error.message,'error');}
}});