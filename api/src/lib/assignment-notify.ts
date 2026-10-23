import { getDb } from './db.js';
import { env } from './env.js';
import { safeError } from './diagnostics.js';
import { isPostmarkConfigured } from './postmark-outbound.js';
import { composeEmail } from './email-branding.js';
import { sendBrandedEmail } from './send-branded-email.js';
import { availableTicketPrivacy } from './ticket-privacy.js';
import { userCanViewTicket } from './role-permissions.js';

// Call after the assignment commits; mail failure must not undo the assignment.
export async function notifyAssignedAgent(args: {
  workspaceId: string; ticketId: string; assigneeId: string | null;
  previousAssigneeId: string | null; actorId?: string | null;
}): Promise<void> {
  const { workspaceId, ticketId, assigneeId, previousAssigneeId, actorId } = args;
  if (!assigneeId || assigneeId === previousAssigneeId || assigneeId === actorId || !isPostmarkConfigured()) return;
  try {
    const privacy = await availableTicketPrivacy(workspaceId, [ticketId]);
    if (!privacy) return;
    const [ticket] = await getDb()`select t.display_id, t.subject, w.name as workspace_name, w.slug
      from tickets t join workspaces w on w.id=t.workspace_id
      where t.workspace_id=${workspaceId} and t.id=${ticketId} and t.assigned_user_id=${assigneeId}
        and w.deleted_at is null and w.suspended_at is null`;
    if (!ticket) return;
    const ticketUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/#/w/${encodeURIComponent(ticket.slug)}/tickets/${encodeURIComponent(ticket.display_id)}`;
    const bodyText = `Ticket ${ticket.display_id} has been assigned to you in ${ticket.workspace_name}.\n\n${ticket.subject}\n\n${ticketUrl}\n\nYou can turn off assignment emails in Settings → Notifications.`;
    const composed = await composeEmail({ workspaceId, authorUserId: null, bodyText, cta: { label: 'Open ticket', url: ticketUrl } });
    const [recipient] = await getDb()`select u.email from tickets t
      join workspace_members wm on wm.workspace_id=t.workspace_id and wm.user_id=t.assigned_user_id and wm.active
      join users u on u.id=wm.user_id and u.deleted_at is null and u.assignment_email_enabled
      where t.workspace_id=${workspaceId} and t.id=${ticketId} and t.assigned_user_id=${assigneeId} and t.deleted_at is null`;
    if (!recipient?.email || !await userCanViewTicket(workspaceId, assigneeId, ticketId)) return;
    await sendBrandedEmail({ workspaceId, privacy, fallbackFromName: ticket.workspace_name,
      to: recipient.email, subject: `Ticket ${ticket.display_id} assigned to you`, textBody: composed.text, htmlBody: composed.html });
  } catch (err) {
    // shortcut: Failed sends are logged without retry; add an outbox if delivery retries are needed.
    console.warn('[assignment-notify] send failed:', safeError(err));
  }
}
