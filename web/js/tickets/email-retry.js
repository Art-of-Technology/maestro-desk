import { TICKETS } from '../core/data.js';
import { CURRENT_TICKET } from '../core/state.js';
import { apiPost, getJwt, getWorkspaceId } from '../core/api-client.js';
import { registerActions } from '../core/event-delegation.js';
import { showToast } from '../core/toast.js';
import { openTicket, notifyReplyDelivery } from './detail.js';

const pending = new Set();
export async function retryEmail(messageId, button) {
  const ticket = TICKETS.find(t => t.id === CURRENT_TICKET);
  const message = ticket?.msgs.find(m => m._uuid === messageId);
  if (!ticket?._uuid || !message || pending.has(messageId)) return;
  const workspace = getWorkspaceId(), jwt = getJwt();
  pending.add(messageId);
  if (button) { button.disabled = true; button.textContent = 'Sending…'; }
  try {
    const result = await apiPost(`/api/v1/tickets/${ticket._uuid}/messages/${messageId}/retry`, {});
    if (getWorkspaceId() !== workspace || getJwt() !== jwt) return;
    message.email = result.email_metadata;
    message.downloadableEmail = result.email_metadata?.status === 'sent';
    notifyReplyDelivery(result.delivery);
    if (CURRENT_TICKET === ticket.id) openTicket(ticket.id);
  } catch (error) {
    if (getWorkspaceId() === workspace && getJwt() === jwt) showToast(error.message || 'Could not retry sending. Refresh the ticket to check delivery.', 'error');
  } finally {
    pending.delete(messageId);
    if (button?.isConnected) { button.disabled = false; button.textContent = 'Retry sending'; }
  }
}
registerActions({ 'emailRetry.send': (data, button) => retryEmail(data.messageId, button) });
