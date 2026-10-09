import { TICKETS } from '../core/data.js';
import { apiGet, getJwt, getWorkspaceId } from '../core/api-client.js';
import { showModal, closeModal } from '../core/modal.js';
import { registerActions } from '../core/event-delegation.js';

function openDownload(ticketId, messageId) {
  const ticket = TICKETS.find(t => t.id === ticketId);
  if (!ticket?._uuid) return;
  const jwt = getJwt(), workspace = getWorkspaceId();
  const single = Boolean(messageId);
  let pending = false;
  showModal(single ? 'Download email' : 'Download thread', `
    <p class="form-row">${single ? 'Download the saved email.' : 'Download all sent and received emails, oldest first. Internal notes, drafts and status changes are excluded.'}</p>
    <div class="form-row">
      <label class="form-label" for="email-download-format">File format</label>
      <select id="email-download-format" class="form-input">
        <option value="pdf">PDF (.pdf)</option>
        <option value="eml">${single ? 'Email (.eml)' : 'Emails (.eml files in a ZIP)'}</option>
      </select>
    </div>
    <p class="form-row">PDF includes the email text and attachment names. Email files include saved formatting and attachments.</p>
    <p class="form-row">Downloads use saved content in its original language. Some older emails have incomplete sender or recipient details.</p>
    <p id="email-download-error" role="alert"></p>`, async () => {
    if (pending || !current()) return;
    pending = true;
    const button = document.querySelector('#modal-container [data-action="modal.confirm"]');
    const error = document.getElementById('email-download-error');
    const format = select.value;
    button.disabled = true;
    button.textContent = 'Preparing download…';
    error.textContent = '';
    try {
      const query = new URLSearchParams({ format });
      if (messageId) query.set('messageId', messageId);
      const blob = await apiGet(`/api/v1/tickets/${encodeURIComponent(ticket._uuid)}/emails/download?${query}`, { blob: true });
      if (!current()) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const extension = format === 'pdf' ? 'pdf' : single ? 'eml' : 'zip';
      link.download = `ticket-${ticket.id.replace(/[^a-z0-9_-]/gi, '_')}-${single ? messageId : 'thread'}.${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      closeModal();
    } catch (err) {
      if (current()) error.textContent = err?.message || 'The download failed. Try again.';
    } finally {
      pending = false;
      if (current()) { button.disabled = false; button.textContent = 'Download'; }
    }
  }, 'Download');
  const select = document.getElementById('email-download-format');
  function current() {
    return select.isConnected && getJwt() === jwt && getWorkspaceId() === workspace;
  }
  select.focus();
}

registerActions({ 'emailDownload.open': ds => openDownload(ds.ticketId, ds.messageId) });
