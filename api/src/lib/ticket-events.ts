import { safeError } from './diagnostics.js';
import { notifySlack } from './slack-notify.js';
import { dispatchTicketEvent } from './outgoing-webhooks.js';

// Tell the brand's Slack channel and outgoing webhooks about a new ticket.
// Every creation path calls this after its transaction commits, so a ticket
// that arrives by email or through the portal is announced the same way as
// one an agent creates. Never throws: a notification failure must not undo
// or fail an accepted ticket.
export async function announceTicketCreated(workspaceId: string, ticketId: string): Promise<void> {
  try { await dispatchTicketEvent({ workspaceId, event: 'ticket.created', ticketId }); }
  catch (err) { console.warn('[outgoing-webhooks] created failed:', safeError(err)); }
  try { await notifySlack({ workspaceId, event: 'ticket.created', ticketId }); }
  catch (err) { console.warn('[slack] notify created failed:', safeError(err)); }
}
