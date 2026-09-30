import { CHANNELS, TICKETS } from '../core/data.js';
import { CURRENT_TICKET } from '../core/state.js';
import { apiPatch, getJwt, getWorkspaceId } from '../core/api-client.js';
import { applySavedActivity } from '../core/ticket-history.js';
import { showModal, closeModal } from '../core/modal.js';
import { showToast } from '../core/toast.js';
import { openTicket } from './detail.js';
import { replyDraft } from './email-details.js';
import { saveDraftRecipients } from './drafts.js';

function channelFor(ticket) { return CHANNELS.find(c => (c._uuid || c.id) === ticket.channelId); }
export function inboxLabel(ticket) {
  return channelFor(ticket)?.name || (ticket.channelId ? 'Unavailable inbox' : 'Unassigned');
}
export function renderTicketInbox(ticket) {
  const label = `Inbox: ${inboxLabel(ticket)}`;
  const channel = channelFor(ticket);
  return `<details class="ticket-popover ticket-inbox">
    <summary class="btn btn-sm" title="${window.escAttr(label)}" aria-label="${window.escAttr(label)}">${window.escHtml(label)} <span aria-hidden="true">▾</span></summary>
    <div class="ticket-popover-panel"><span>${window.escHtml(channel?.address || (ticket.channelId ? 'Inbox address unavailable' : 'No email inbox assigned'))}</span>
      <button type="button" class="btn btn-sm" data-action="td.moveInbox" data-ticket-id="${window.escAttr(ticket.id)}">Move to inbox…</button>
    </div></details>`;
}

export async function moveTicketInbox(ticket, channelId, expected = { channelId: ticket.channelId || null, updatedAt: ticket._listUpdatedAt }) {
  if (ticket._inboxSaving) return null;
  const workspace = getWorkspaceId(), jwt = getJwt();
  const current = () => workspace === getWorkspaceId() && jwt === getJwt() && TICKETS.includes(ticket);
  ticket._inboxSaving = true;
  try {
    const result = ticket._uuid ? await apiPatch(`/api/v1/tickets/${ticket._uuid}/inbox`, {
      channel_id: channelId, expected_channel_id: expected.channelId, expected_updated_at: expected.updatedAt,
    }) : { ticket: { channel_id: channelId, updated_at: new Date().toISOString() }, activity: [] };
    if (!current()) return null;
    // Keep recipients and body; only the sender follows the moved ticket.
    const draft = replyDraft(ticket);
    ticket.channelId = result.ticket.channel_id;
    ticket._listUpdatedAt = result.ticket.updated_at;
    if (result.reply_recipients) ticket.replyRecipients = result.reply_recipients;
    const sender = ticket.replyRecipients?.sending_inboxes?.find(c => c.id === (ticket.channelId || ticket.replyRecipients.default_sending_channel_id));
    if (ticket.replyRecipients) {
      ticket.replyRecipients.default_sending_channel_id = sender?.id || null;
      saveDraftRecipients(ticket.id, { ...draft, ticket_channel_id: ticket.channelId,
        sending_channel_id: sender?.id || null, sending_address: sender?.address || null });
    }
    applySavedActivity(ticket, result);
    if (CURRENT_TICKET === ticket.id) openTicket(ticket.id);
    return { channelId: ticket.channelId, updatedAt: ticket._listUpdatedAt };
  } catch (error) {
    if (current()) showToast(error?.message || 'Could not move the ticket. Try again.', 'error');
    return null;
  } finally { ticket._inboxSaving = false; }
}

export function showMoveInbox(id) {
  const ticket = TICKETS.find(t => t.id === id);
  if (!ticket || ticket._inboxSaving) return;
  const choices = CHANNELS.filter(c => c.type === 'email' && c.status === 'active' && (c._uuid || c.id) !== ticket.channelId);
  if (!choices.length) { showToast('No other active email inboxes are available.'); return; }
  const previous = ticket.channelId || null;
  const expected = { channelId: previous, updatedAt: ticket._listUpdatedAt };
  const workspace = getWorkspaceId(), jwt = getJwt();
  showModal('Move to inbox', `<label for="move-inbox">Inbox</label>
    <select id="move-inbox" class="form-input">${choices.map(c => `<option value="${window.escAttr(c._uuid || c.id)}">${window.escHtml(c.name)}${c.address ? ` · ${window.escHtml(c.address)}` : ''}</option>`).join('')}</select>
    <p>Future replies will use this inbox when its sending address is verified. Your draft and conversation stay with the ticket.</p>`, async () => {
    if (workspace !== getWorkspaceId() || jwt !== getJwt() || !TICKETS.includes(ticket)) return;
    const select = document.getElementById('move-inbox');
    const channelId = select?.value;
    if (!choices.some(c => (c._uuid || c.id) === channelId)) return;
    const moved = await moveTicketInbox(ticket, channelId, expected);
    if (!moved) return;
    if (select === document.getElementById('move-inbox')) closeModal();
    showToast(`Moved to ${inboxLabel(ticket)}`, 'success', 10000, null, { label: 'Undo', onClick: async () => {
      if (workspace !== getWorkspaceId() || jwt !== getJwt() || !TICKETS.includes(ticket)) return;
      if (await moveTicketInbox(ticket, previous, moved)) showToast(`Moved back to ${inboxLabel(ticket)}`, 'success');
    } });
  }, 'Move');
}
