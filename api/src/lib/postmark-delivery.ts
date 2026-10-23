import { z } from 'zod';
import { getDb } from './db.js';

export const PostmarkDelivery = z.object({
  RecordType: z.literal('Delivery'),
  MessageStream: z.literal('outbound'),
  MessageID: z.string().uuid(),
  Recipient: z.string().email().max(320),
  DeliveredAt: z.string().datetime({ offset: true }),
  // Other callers and historical sends have no correlation metadata.
  Metadata: z.record(z.string(), z.string()).default({}),
});

const Reference = z.object({
  workspace_id: z.string().uuid(), message_id: z.string().uuid(), send_attempt_id: z.string().uuid(),
});

export async function processDeliveryEvent(payload: z.infer<typeof PostmarkDelivery>): Promise<boolean> {
  const reference = Reference.safeParse(payload.Metadata);
  if (!reference.success) return false;
  const { workspace_id: workspaceId, message_id: messageId, send_attempt_id: attemptId } = reference.data;
  const recipient = payload.Recipient.toLowerCase();
  const sql = getDb();
  return sql.begin(async tx => {
    // Lock the original row: concurrent recipients and send acknowledgements must retain every receipt.
    const [message] = await tx`select m.email_metadata from ticket_messages m
      join tickets t on t.id=m.ticket_id and t.workspace_id=m.workspace_id
      join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
      join workspaces w on w.id=m.workspace_id
      where m.workspace_id=${workspaceId} and m.id=${messageId}
        and m.role='agent' and m.deleted_at is null and m.body<>'[erased]'
        and m.merged_from_id is null and cardinality(m.forwarded_from_ticket_ids)=0
        and t.deleted_at is null and t.merged_into_id is null
        and c.deleted_at is null and c.erased_at is null and w.deleted_at is null
        and m.email_metadata->>'send_attempt_id'=${attemptId}
      for update of m`;
    if (!message) return false;
    const metadata = message.email_metadata;
    const recipients: string[] = [...(metadata.to || []), ...(metadata.cc || [])];
    if (!recipients.some(address => address.toLowerCase() === recipient)
      || (metadata.postmark_message_id && metadata.postmark_message_id !== payload.MessageID)) return false;
    const delivered = { ...(metadata.delivered_recipients || {}) };
    if (delivered[recipient]) return true;
    delivered[recipient] = payload.DeliveredAt;
    await tx`update ticket_messages set
      external_message_id=coalesce(external_message_id,email_metadata->>'pending_message_id'),
      email_metadata=email_metadata || ${sql.json({ status: 'sent', delivery_state: 'sent',
        postmark_message_id: payload.MessageID, delivered_recipients: delivered,
        sent_at: metadata.sent_at || metadata.send_attempt_at,
      })}
      where id=${messageId} and workspace_id=${workspaceId}`;
    return true;
  });
}
