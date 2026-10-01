import { apiGet, getWorkspaceId, getJwt } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';

let activePreview = null;
export async function previewAttachment({ticketUuid,attId,filename}) {
  activePreview?.close();
  const trigger=document.activeElement, workspace=getWorkspaceId(), jwt=getJwt();
  const dialog=document.createElement('dialog'), controller=new AbortController();
  dialog.className='attachment-preview';dialog.setAttribute('aria-labelledby','attachment-preview-title');
  dialog.innerHTML=`<div class="attachment-preview-head"><h2 id="attachment-preview-title">${window.escHtml(filename||'Attachment')}</h2>
    <button type="button" class="btn" data-close>Close</button></div>
    <div class="attachment-preview-body" aria-live="polite"><p>Loading file…</p></div>
    <div class="attachment-preview-foot"><a class="btn" hidden>Download file</a></div>`;
  let url;
  const current=()=>dialog.open && workspace===getWorkspaceId() && jwt===getJwt();
  const checkScope=()=>{if(!current())dialog.close();};
  dialog.addEventListener('close',()=>{
    controller.abort();if(url)URL.revokeObjectURL(url);dialog.remove();
    window.removeEventListener('focus',checkScope);
    if(activePreview===dialog)activePreview=null;
    if(trigger?.isConnected)trigger.focus();
  },{once:true});
  dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  document.body.appendChild(dialog);activePreview=dialog;dialog.showModal();
  window.addEventListener('focus',checkScope);
  const body=dialog.querySelector('.attachment-preview-body');
  try {
    const blob=await apiGet(`/api/v1/tickets/${encodeURIComponent(ticketUuid)}/attachments/${encodeURIComponent(attId)}/content`,{blob:true,signal:controller.signal});
    if(!current()){dialog.close();return;}
    url=URL.createObjectURL(blob);
    const download=dialog.querySelector('a');download.href=url;download.download=filename||'attachment';download.hidden=false;
    if(['image/png','image/jpeg','image/webp','image/gif'].includes(blob.type)){
      const img=document.createElement('img');img.alt=filename||'Attachment';img.src=url;
      img.addEventListener('error',()=>{body.textContent='This image could not be displayed. You can download the file.';});
      body.replaceChildren(img);
    } else if(blob.type==='application/pdf'){
      // Only API-verified PDF bytes reach the browser's native PDF viewer; HTML/SVG are download-only.
      const frame=document.createElement('iframe');frame.title=filename||'PDF preview';frame.src=url+'#view=FitH';
      const hint=document.createElement('p');hint.textContent='If the PDF does not display in this browser, use Download file.';
      body.replaceChildren(frame,hint);
    } else body.textContent='Preview is not available for this file type. You can download it below.';
  }catch(error){if(current())body.textContent=error.message||'Could not load the file. Close this preview and try again.';}
}
registerActions({'att.preview':previewAttachment});
