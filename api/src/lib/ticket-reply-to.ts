import { z } from 'zod';
import { getDb } from './db.js';
import { env } from './env.js';
import { getOutboundFrom } from './outbound-from.js';

const emailAddress = z.string().email();

// Public inboxes forward to Postmark. Keep that transport address hidden when
// the ticket's brand has a public address, without changing threading headers.
export async function resolveTicketReplyTo(workspaceId: string, ticketId: string): Promise<string | null> {
  const sql = getDb();
  const [ticket] = await sql<{ address: string | null }[]>`
    select ch.address
    from tickets t
    left join channels ch on ch.id = t.channel_id
      and ch.workspace_id = t.workspace_id
      and ch.type = 'email' and ch.status = 'active' and ch.deleted_at is null
    where t.id = ${ticketId} and t.workspace_id = ${workspaceId} and t.deleted_at is null
  `;
  if (!ticket) return null;

  const address = ticket.address?.trim();
  if (address && emailAddress.safeParse(address).success) return address;

  const sender = await getOutboundFrom(workspaceId);
  return sender?.fromEmail || env.POSTMARK_INBOUND_REPLY_ADDRESS || null;
}
