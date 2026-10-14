import { CUSTOMERS, TICKETS } from '../core/data.js';
import { apiGet, apiPost, getJwt, getWorkspaceId } from '../core/api-client.js';
import { showModal, showDangerConfirm } from '../core/modal.js';
import { registerActions } from '../core/event-delegation.js';
import { invalidateDraftTicket } from '../tickets/drafts.js';
import { showToast } from '../core/toast.js';

let active = null;
let busy = false;
const sameScope = ctx => ctx.jwt === getJwt() && ctx.workspace === getWorkspaceId();
const current = ctx => active === ctx && sameScope(ctx) && ctx.panel?.isConnected;

export function showGDPRModal(ticketId, action) {
  const ticket = TICKETS.find(t => t.id === ticketId);
  const customer = CUSTOMERS.find(c => c.id === ticket?.customerId);
  if (!window.isAdmin()) { showToast('An administrator must handle this request.', 'warn'); return; }
  if (!customer?._uuid || !getJwt() || !getWorkspaceId()) { showToast('Open a saved ticket with a customer first.', 'warn'); return; }
  if (busy) { showToast('A privacy action is still running. Wait for its result.', 'info'); return; }
  const ctx = { id:customer._uuid, displayId:customer.id, jwt:getJwt(), workspace:getWorkspaceId(), tickets:TICKETS.filter(t=>t.customerId===customer.id).map(t=>t.id) };
  active = ctx;
  showModal('Customer privacy', `
    <div id="privacy-actions">
      <p>Customer <strong>${window.escHtml(customer.id)}</strong> · ${window.escHtml([customer.first,customer.last].filter(Boolean).join(' '))}</p>
      <div class="gdpr-action"><div class="gdpr-action-title">Export customer records</div>
        <p>Download customer records and linked activity and audit history for review. Attachment details are included; the files themselves are not. Records without a reliable customer link need a separate search.</p>
        <p>Review the export for information about other people and decide which documents to include before sharing it. This download is not sent to the customer.</p>
        <button type="button" class="btn btn-sm" data-action="privacy.export">Download for review</button></div>
      <div class="gdpr-action"><div class="gdpr-action-title">Erase customer data</div>
        <p>Erase supported customer, ticket and activity content. Audit records remain and may contain historical personal information requiring separate review. This cannot be undone.</p>
        <button type="button" class="btn btn-sm btn-danger" data-action="privacy.erase">Review erasure</button></div>
      <p id="privacy-error" role="alert"></p>
      <button type="button" class="btn" data-action="modal.close">Close</button>
    </div>`, null, null);
  ctx.panel = document.getElementById('privacy-actions');
  ctx.panel.closest?.('.modal')?.classList.add('privacy-modal');
  if (action === 'erase') confirmErasure();
}

async function downloadExport() {
  const ctx = active;
  if (!ctx || !current(ctx) || busy || !window.isAdmin()) return;
  const error = document.getElementById('privacy-error');
  busy = true; error.textContent = 'Preparing export…';
  try {
    const bundle = await apiGet(`/api/v1/customers/${encodeURIComponent(ctx.id)}/export`);
    if (!current(ctx)) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)], {type:'application/json'}));
    const link = document.createElement('a');
    link.href = url; link.download = `customer-${String(ctx.displayId).replace(/[^A-Za-z0-9._-]/g,'_')}-review.json`;
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000); }
    error.textContent = 'Download prepared. Review it before sharing; attachment files are not included.';
  } catch (err) { if (current(ctx)) error.textContent = err.message || 'Export failed. Try again.'; }
  finally { busy = false; }
}

function confirmErasure() {
  const ctx = active;
  if (!ctx || !current(ctx) || busy || !window.isAdmin()) return;
  showDangerConfirm({ title:'Erase customer data', confirmLabel:'Erase customer data', typeToConfirm:ctx.displayId,
    bodyHtml:`<div id="privacy-erasure">
      <p>This erases customer <strong>${window.escHtml(ctx.displayId)}</strong> and personal data on their tickets, including saved drafts and uploaded files.</p>
      <p>Confirm that your team has checked the request and any records it must retain. This action cannot be undone. Existing exports, backups and copies held by recipients are handled separately.</p>
      <p>Audit records remain and may contain historical personal information. Review retained history separately before confirming that the request is complete.</p>
      <label class="form-label" for="privacy-reason">Reason</label>
      <select class="form-input" id="privacy-reason"><option value="subject_request">Customer request</option><option value="retention_expired">Retention period ended</option><option value="consent_withdrawn">Consent withdrawn</option><option value="other">Other approved reason</option></select>
      <p id="privacy-error" role="alert"></p></div>`,
    onConfirm:async () => {
      if (!current(ctx) || busy || !window.isAdmin()) return;
      const error = document.getElementById('privacy-error');
      const reason = document.getElementById('privacy-reason').value.trim();
      busy = true; error.textContent = 'Erasing customer data…';
      try {
        const result = await apiPost(`/api/v1/customers/${encodeURIComponent(ctx.id)}/erase`, {reason});
        if (!result?.erased) throw Error('Erasure was not confirmed. Check the customer record before trying again.');
        try {
          for(const id of ctx.tickets)invalidateDraftTicket(id,true,ctx.workspace,null);
          localStorage.setItem('respovia:customer-erased-record',JSON.stringify({workspace:ctx.workspace,nonce:Date.now()}));
        } catch { /* A blocked browser store must not prevent the reload after confirmed erasure. */ }
        if (!sameScope(ctx)) return;
        window.dispatchEvent(new CustomEvent('respovia:customer-erased',{detail:{id:ctx.displayId}}));
        // Reload discards hydrated customer/ticket objects and any open attachment previews.
        window.alert(`Supported customer content erased. Tickets affected: ${result.ticketsAffected}. Messages redacted: ${result.messagesRedacted}. Attachments removed: ${result.attachmentsDeleted}. File storage deletion is retried if needed. Audit records remain and require separate review, including after a repeated erasure.`);
        window.location.reload();
      } catch (err) {
        if (current(ctx)) error.textContent = err.message || 'Erasure failed. Check the customer record before trying again.';
        else if (sameScope(ctx)) showToast('The erasure result could not be confirmed. Check the customer record.', 'error');
      } finally { busy = false; }
    },
  });
  ctx.panel = document.getElementById('privacy-erasure');
  ctx.panel.closest?.('.modal')?.classList.add('privacy-modal');
  document.getElementById('danger-confirm-input')?.setAttribute('aria-label','Type customer ID to confirm erasure');
}

registerActions({'privacy.export':downloadExport,'privacy.erase':confirmErasure});
window.addEventListener?.('respovia:auth-scope-changed',()=>{active=null;});

window.addEventListener?.('storage',event=>{
  if(event.key!=='respovia:customer-erased-record'||!event.newValue)return;
  try {if(JSON.parse(event.newValue).workspace===getWorkspaceId())window.location.reload();} catch {}
});
