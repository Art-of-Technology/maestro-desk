import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import type { TransactionSql } from 'postgres';
import { getDb } from './db.js';
import { effectivePermissions } from './role-permissions.js';
import { activeTicketStatus, validateStatusReason } from './ticket-status.js';
import { recordTicketActivity } from './ticket-activity.js';
import { notifySlack } from './slack-notify.js';
import { dispatchTicketEvent } from './outgoing-webhooks.js';
import { sendCsatSurvey } from './csat-survey.js';
import { publishTicketChanged } from './pubby.js';
import { safeError } from './diagnostics.js';

export const ReplyStatus = z.object({ status: z.string().min(1).max(64), reason: z.string().max(64).nullable() }).strict();

async function validate(tx: TransactionSql, workspaceId: string, ticketId: string, actorId: string, action: z.infer<typeof ReplyStatus>) {
  const [row] = await tx`select t.status_key,t.status_option_key,t.assigned_user_id,
      r.is_admin,r.permissions,r.can_delete,r.can_manage_custom_fields,u.is_platform_admin
    from tickets t join workspaces w on w.id=t.workspace_id
    join users u on u.id=${actorId} and u.deleted_at is null
    left join workspace_members wm on wm.user_id=u.id and wm.workspace_id=t.workspace_id and wm.active
    left join roles r on r.id=wm.role_id and r.workspace_id=wm.workspace_id
    where t.id=${ticketId} and t.workspace_id=${workspaceId} and t.deleted_at is null and t.merged_into_id is null
      and w.deleted_at is null and w.suspended_at is null
      and (not w.is_unrouted_bucket or u.is_platform_admin)
      and ((wm.user_id is not null and r.id is not null) or u.is_platform_admin)`;
  if (!row) throw new HTTPException(403, { message: 'The ticket or your access changed. Review its status.' });
  const permissions = effectivePermissions(row, row.is_platform_admin);
  const choice = await activeTicketStatus(tx, workspaceId, action.status);
  if (!permissions['tickets.edit'] || !permissions['tickets.close']
    || !(permissions['tickets.view_all'] || permissions['tickets.view_assigned'] && row.assigned_user_id === actorId)
    || choice.base_key === 'gdpr' && !permissions['data.erase_request']) {
    throw new HTTPException(403, { message: 'Your role does not allow this status action.' });
  }
  if (choice.base_key === 'closed' || row.status_key === 'closed' && choice.base_key !== 'open') {
    throw new HTTPException(409, { message: 'Use the separate close or reopen action for this ticket.' });
  }
  const reason = validateStatusReason(choice, action.reason);
  return { ticket: row, choice, reason };
}

async function statusEvent(tx: TransactionSql, workspaceId: string, ticketId: string) {
  const [event] = await tx`select id from events where workspace_id=${workspaceId} and entity_type='ticket'
    and entity_id=${ticketId} and kind='status' order by created_at desc,id desc limit 1`;
  return event?.id || null;
}

// Save the chosen action with the reply, before contacting the email provider.
export async function prepareReplyStatus(tx: TransactionSql, workspaceId: string, ticketId: string, actorId: string, action: z.infer<typeof ReplyStatus>) {
  await tx`select id from tickets where id=${ticketId} and workspace_id=${workspaceId} for update`;
  const { ticket } = await validate(tx, workspaceId, ticketId, actorId, action);
  const [{ count }] = await tx`select count(*)::int as count from ticket_messages where workspace_id=${workspaceId}
    and ticket_id=${ticketId} and role in ('customer','agent') and deleted_at is null`;
  return { ...action, state: 'pending', before: ticket.status_option_key, reply_count: count, status_event: await statusEvent(tx, workspaceId, ticketId) };
}

// Both the send acknowledgement and a later receipt finish the same saved action.
export async function completeReplyStatus(workspaceId: string, messageId: string) {
  const sql = getDb();
  const result = await sql.begin(async tx => {
    const [owner] = await tx`select t.id,t.customer_id from ticket_messages m
      join tickets t on t.id=m.ticket_id and t.workspace_id=m.workspace_id
      where m.id=${messageId} and m.workspace_id=${workspaceId} and m.email_metadata ? 'after_send'`;
    if (!owner) return;
    // Match erasure's customer -> ticket -> message lock order.
    const [customer] = await tx`select id from customers where id=${owner.customer_id} and workspace_id=${workspaceId}
      and deleted_at is null and erased_at is null for update`;
    if (!customer) return;
    const [ticket] = await tx`select status_option_key from tickets where id=${owner.id} and workspace_id=${workspaceId}
      and customer_id=${owner.customer_id} and deleted_at is null and merged_into_id is null for update`;
    if (!ticket) return;
    // A concurrent provider acknowledgement may hold the message and need the ticket lock.
    const [message] = await tx`select author_user_id,email_metadata,created_at from ticket_messages
      where id=${messageId} and workspace_id=${workspaceId} and ticket_id=${owner.id} and role='agent'
        and deleted_at is null and body<>'[erased]' and merged_from_id is null and cardinality(forwarded_from_ticket_ids)=0 for update nowait`;
    const action = message?.email_metadata?.after_send;
    if (!action || action.state !== 'pending' || message.email_metadata.status !== 'sent') return;
    let checked;
    try {
      checked = await validate(tx, workspaceId, owner.id, message.author_user_id, action);
      const [newer] = await tx`select id from ticket_messages where workspace_id=${workspaceId} and ticket_id=${owner.id}
        and id<>${messageId} and role in ('customer','agent') and deleted_at is null and created_at>${message.created_at} limit 1`;
      // A reply's timestamp can predate its commit when its transaction waited on the ticket.
      const [{ count }] = await tx`select count(*)::int as count from ticket_messages where workspace_id=${workspaceId}
        and ticket_id=${owner.id} and id<>${messageId} and role in ('customer','agent') and deleted_at is null`;
      if (ticket.status_option_key !== action.before || await statusEvent(tx, workspaceId, owner.id) !== action.status_event || newer || count !== action.reply_count) {
        throw new HTTPException(409, { message: 'The ticket changed after sending. Review its status.' });
      }
    } catch (err) {
      if (!(err instanceof HTTPException)) throw err;
      await tx`update ticket_messages set email_metadata=jsonb_set(email_metadata,'{after_send,state}','"review"')
        where id=${messageId} and workspace_id=${workspaceId}`;
      return { ticketId: owner.id, changed: false };
    }
    const { choice, reason } = checked;
    const changed = ticket.status_option_key !== choice.key;
    if (changed) {
      const reopen = checked.ticket.status_key === 'closed'
        ? tx`, closure_reason=null,closure_note=null,closed_at=null,closed_by_user_id=null` : tx``;
      await tx`update tickets set status_key=${choice.base_key},status_option_key=${choice.key},
        status_reason=${reason?.key || null},status_reason_label=${reason?.label || null},
        resolved_at=case when ${choice.base_key}='resolved' then coalesce(resolved_at,now()) else null end ${reopen}
        where id=${owner.id} and workspace_id=${workspaceId}`;
      await recordTicketActivity(tx, { workspaceId, ticketId: owner.id, actorId: message.author_user_id,
        kind: 'status', before: ticket.status_option_key, after: choice.key, context: { reason_label: reason?.label || null } });
    }
    await tx`update ticket_messages set email_metadata=jsonb_set(email_metadata,'{after_send,state}','"applied"')
      where id=${messageId} and workspace_id=${workspaceId}`;
    return { ticketId: owner.id, changed, category: choice.base_key, previousCategory: checked.ticket.status_key };
  });
  if (!result) return;
  if (result.changed && (result.category === 'resolved' || result.category === 'escalated')) {
    if (result.category !== result.previousCategory) {
      const event = result.category === 'resolved' ? 'ticket.resolved' as const : 'ticket.escalated' as const;
      for (const notify of [notifySlack, dispatchTicketEvent]) {
        try { await notify({ workspaceId, ticketId: result.ticketId, event }); }
        catch (err) { console.warn('[reply-status] notification failed:', safeError(err)); }
      }
    }
    if (result.category === 'resolved') {
      try { await sendCsatSurvey({ workspaceId, ticketId: result.ticketId }); }
      catch (err) { console.warn('[reply-status] survey failed:', safeError(err)); }
    }
  }
  await publishTicketChanged(workspaceId, result.ticketId);
}
