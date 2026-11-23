import { safeError } from './diagnostics.js';
import { notifySlack } from './slack-notify.js';
import { dispatchTicketEvent } from './outgoing-webhooks.js';

// Tell the brand's Slack channel and outgoing webhooks about a new ticket.
// Every creation path (agent, portal, inbox conversion, inbound email) calls
// this after its transaction commits and after assignment rules have run, so
// the announcement carries the ticket's first assignee. That is why creation
// sends no separate ticket.assigned event. Never throws: a notification
// failure must not undo or fail an accepted ticket.
//
// The webhook enqueue is a quick database insert and is always awaited, so an
// accepted ticket cannot lose it. The Slack post is awaited too by default
// (an unawaited call can be dropped when the runtime freezes as the response
// is written; it is bounded by Slack's 15-second request timeout). Inbound
// email passes slack: 'background' because Postmark must be answered quickly.
export async function announceTicketCreated(workspaceId: string, ticketId: string,
  opts: { slack?: 'await' | 'background' } = {}): Promise<void> {
  try { await dispatchTicketEvent({ workspaceId, event: 'ticket.created', ticketId }); }
  catch (err) { console.warn('[outgoing-webhooks] created failed:', safeError(err)); }
  const slack = notifySlack({ workspaceId, event: 'ticket.created', ticketId })
    .catch(err => { console.warn('[slack] notify created failed:', safeError(err)); });
  if (opts.slack !== 'background') await slack;
}
