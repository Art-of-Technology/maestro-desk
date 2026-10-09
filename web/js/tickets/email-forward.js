import { TICKETS } from '../core/data.js';
import { apiGet, apiPost, getJwt, getWorkspaceId } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';
import { showToast } from '../core/toast.js';
import { registerActions } from '../core/event-delegation.js';
import { reloadTicketByUuid } from './detail.js';
import { renderEmailPreview } from './message-html.js';

function prepareDialog(trigger) {
  const dialog=document.querySelector('#modal-container .modal');
  dialog.setAttribute('role','dialog');
  dialog.setAttribute('aria-modal','true');
  dialog.setAttribute('aria-label','Forward email');
  dialog.tabIndex=-1;
  dialog.querySelector('.modal-close').outerHTML='<button type="button" class="btn modal-close" data-action="modal.close" aria-label="Close forwarding form">×</button>';
  dialog.addEventListener('keydown',event=>{
    if(event.key==='Escape') {event.preventDefault();closeModal();return;}
    if(event.key!=='Tab')return;
    const controls=[...dialog.querySelectorAll('button,input,select,textarea,summary')].filter(el=>!el.disabled && el.getClientRects().length);
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey && (document.activeElement===first || document.activeElement===dialog)) {event.preventDefault();last?.focus();}
    else if(!event.shiftKey && document.activeElement===last) {event.preventDefault();first?.focus();}
  });
  const observer=new MutationObserver(()=>{
    if(dialog.isConnected)return;
    observer.disconnect();
    if(!document.querySelector('#modal-container .modal'))trigger?.focus();
  });
  observer.observe(document.getElementById('modal-container'),{childList:true});
  dialog.focus();
}

async function openForward(ticketId, messageId) {
  const ticket=TICKETS.find(t=>t.id===ticketId);
  if (!ticket?._uuid) return;
  const jwt=getJwt(), workspace=getWorkspaceId(), trigger=document.activeElement;
  const path=`/api/v1/tickets/${encodeURIComponent(ticket._uuid)}/emails/${encodeURIComponent(messageId)}/forward`;
  let root, pending=false, requestId=crypto.randomUUID();
  const current=()=>root?.isConnected && getJwt()===jwt && getWorkspaceId()===workspace;
  showModal('Forward email','<div id="email-forward-form">Loading email…</div>',null);
  prepareDialog(trigger);
  root=document.getElementById('email-forward-form');
  try {
    const data=await apiGet(path);
    if (!current()) return;
    const esc=window.escHtml, attr=window.escAttr;
    showModal('Forward email',`<form id="email-forward-form">
      <div class="form-row"><label class="form-label" for="forward-from">From</label>
        <select class="form-input" id="forward-from"><option value="">Workspace default — ${esc(data.default_from)}</option>
          ${data.sending_inboxes.map(i=>`<option value="${attr(i.id)}" ${i.id===data.default_sending_channel_id?'selected':''}>${esc(i.address)}</option>`).join('')}</select></div>
      <div class="form-row"><label class="form-label" for="forward-to">To (required)</label><input class="form-input" id="forward-to" type="email" multiple required autocomplete="off" placeholder="Email addresses, separated by commas"></div>
      <div class="form-row"><label class="form-label" for="forward-cc">CC (optional)</label><input class="form-input" id="forward-cc" type="email" multiple autocomplete="off"></div>
      <div class="form-row"><label class="form-label" for="forward-subject">Subject</label><input class="form-input" id="forward-subject" maxlength="500" required value="${attr(data.subject)}"></div>
      <div class="form-row"><label class="form-label" for="forward-message">Your message (optional)</label><textarea class="form-input" id="forward-message" rows="4" maxlength="20000" placeholder="Add a message above the original email"></textarea></div>
      ${data.attachments.length?`<fieldset class="form-row" style="min-width:0;padding:12px;border:1px solid var(--rule);border-radius:var(--r)"><legend>Attachments</legend><p>Uncheck files or inline images you do not want to forward.</p>
        ${data.attachments.map(a=>`<label style="display:flex;align-items:center;gap:8px;min-height:44px;overflow-wrap:anywhere"><input type="checkbox" name="forward-file" value="${attr(a.id)}" checked> ${esc(a.filename)}${a.is_inline?' (inline image)':''}</label>`).join('')}</fieldset>`:''}
      <details class="form-row"><summary>Original email</summary>${renderEmailPreview(data.original.html,data.attachments)}</details>
      <p class="form-row">Only this email and the selected attachments will be forwarded. Internal notes and status changes are excluded. Replies to this forward will open a separate ticket.</p>
      <p id="forward-error" role="alert" tabindex="-1"></p>
    </form>`,async()=>{
      if (!current() || pending || !root.reportValidity()) return;
      pending=true;
      const button=document.querySelector('#modal-container [data-action="modal.confirm"]');
      const error=document.getElementById('forward-error');
      button.disabled=true; button.textContent='Forwarding…'; error.textContent='';
      const addresses=id=>document.getElementById(id).value.split(',').map(v=>v.trim()).filter(Boolean);
      const inbox=data.sending_inboxes.find(i=>i.id===document.getElementById('forward-from').value);
      try {
        await apiPost(path,{request_id:requestId,source_version:data.source_version,to:addresses('forward-to'),cc:addresses('forward-cc'),
          subject:document.getElementById('forward-subject').value,message:document.getElementById('forward-message').value,
          sending_channel_id:inbox?.id || null,sending_address:inbox?.address || null,
          attachment_ids:[...root.querySelectorAll('[name="forward-file"]:checked')].map(el=>el.value)});
        if (!current()) return;
        closeModal(); showToast('Email forwarded'); reloadTicketByUuid(ticket._uuid);
      } catch(err) {
        if (!current()) return;
        error.textContent=err?.message || 'Could not forward the email. Check the ticket before trying again.';
        error.focus();
        if (err?.body?.retryable) requestId=crypto.randomUUID();
      } finally {
        pending=false;
        if (current()) {button.disabled=false;button.textContent='Send forward';}
      }
    },'Send forward',true);
    prepareDialog(trigger);
    root=document.getElementById('email-forward-form');
    root.addEventListener('submit',e=>e.preventDefault());
    document.getElementById('forward-to').focus();
  } catch(err) { if (current()) root.textContent=err?.message || 'Could not load this email.'; }
}

registerActions({'emailForward.open':ds=>openForward(ds.ticketId,ds.messageId)});
