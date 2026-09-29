import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { getDb } from './db.js';
import { env } from './env.js';
import { getOutboundFrom, getSendingInboxes } from './outbound-from.js';
import { resolveTicketRecipient } from './ticket-recipient.js';
import { parseFrom, type PostmarkInbound } from './postmark.js';

export const EmailRecipients = z.object({
  sending_channel_id: z.string().uuid().nullable().optional(),
  sending_address: z.string().email().nullable().optional(),
  source_message_id: z.string().uuid().nullable(),
  to: z.array(z.string().trim().email().max(254)).max(1),
  mode: z.enum(['reply', 'reply_all']),
  cc: z.array(z.string().trim().email().max(254)).max(49),
});
export type RecipientInput = z.infer<typeof EmailRecipients>;
export type EmailMetadata = {
  from: string; to: string[]; cc: string[]; reply_to?: string | null;
  received_via?: string | null; received_at?: string; sent_at?: string | null;
  status: 'received' | 'saved' | 'sent';
};
export function cleanEmails(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.map(v => v?.trim().toLowerCase()).filter((v): v is string => !!v && z.string().email().max(254).safeParse(v).success))];
}
function singleAddress(value?: string): string | null {
  if (!value || /[\r\n]/.test(value)) return null;
  return cleanEmails([value.match(/^[^<>]*<([^<>]+)>$/)?.[1] || value])[0] || null;
}
export async function inboundEmailMetadata(workspaceId: string, payload: PostmarkInbound): Promise<EmailMetadata> {
  const to = cleanEmails((payload.ToFull || []).map(v => v.Email));
  const cc = cleanEmails((payload.CcFull || []).map(v => v.Email));
  const channels = await getDb()`select address from channels where workspace_id=${workspaceId}
    and type='email' and deleted_at is null and status='active'`;
  const addresses = cleanEmails(channels.map(c => c.address));
  const candidates = cleanEmails([payload.OriginalRecipient, ...to, ...cc]);
  const date = payload.Date ? new Date(payload.Date) : null;
  return { received_at: new Date().toISOString(), from: cleanEmails([parseFrom(payload).email])[0] || '', to, cc,
    reply_to: singleAddress(payload.ReplyTo),
    received_via: candidates.find(e => addresses.includes(e)) || null,
    sent_at: date && Number.isFinite(date.getTime()) ? date.toISOString() : null, status: 'received' };
}
export async function ticketReplyRecipients(workspaceId: string, ticketId: string, input?: RecipientInput) {
  const sql = getDb();
  const recipient = await resolveTicketRecipient(workspaceId, ticketId);
  const rows = input?.source_message_id
    ? await sql`select id, email_metadata, external_message_id from ticket_messages where workspace_id=${workspaceId}
        and ticket_id=${ticketId} and id=${input.source_message_id} and role='customer' and deleted_at is null`
    : input ? [] : await sql`select id, email_metadata, external_message_id from ticket_messages where workspace_id=${workspaceId}
        and ticket_id=${ticketId} and role='customer' and deleted_at is null order by created_at desc,id desc limit 1`;
  if (input?.source_message_id && !rows.length) throw new HTTPException(400, { message: 'The email being replied to is no longer available. Reopen the ticket.' });
  const source = rows[0];
  const meta = source?.email_metadata as EmailMetadata | null;
  const channels = await sql`select address from channels where workspace_id=${workspaceId} and type='email'`;
  const branded = await getOutboundFrom(workspaceId);
  const sendingInboxes = await getSendingInboxes(workspaceId);
  if (input?.sending_channel_id && !sendingInboxes.some(inbox => inbox.id === input.sending_channel_id && inbox.address === input.sending_address?.toLowerCase())) {
    throw new HTTPException(409, { message: 'The selected sending inbox is unavailable or no longer verified. Choose another From inbox.' });
  }
  const defaultInbox = sendingInboxes.find(inbox => inbox.address === meta?.received_via?.toLowerCase());
  const own = new Set(cleanEmails([...channels.map(c => c.address), branded?.fromEmail, env.POSTMARK_OUTBOUND_FROM, env.POSTMARK_INBOUND_REPLY_ADDRESS]));
  const external = (values: string[]) => cleanEmails(values).filter(e => !own.has(e) && !e.endsWith('@inbound.postmarkapp.com'));
  const to = external(meta ? [meta.reply_to || meta.from] : [recipient?.email || '']);
  if (input && JSON.stringify(cleanEmails(input.to)) !== JSON.stringify(to)) throw new HTTPException(409, { message: 'The email recipient changed. Reopen the ticket and review the recipients.' });
  const suggestedCc = external([...(meta?.to || []), ...(meta?.cc || [])]).filter(e => !to.includes(e));
  const cc = input ? external(input.cc).filter(e => !to.includes(e)) : suggestedCc;
  if (input && to.length + cc.length > 50) throw new HTTPException(400, { message: 'Use no more than 50 recipients.' });
  const all = [...to, ...(input ? cc : [])];
  const blocked = all.length ? await sql`select 1 from customer_contacts cc join customers c on c.id=cc.customer_id and c.workspace_id=cc.workspace_id
    where cc.workspace_id=${workspaceId} and cc.kind='email' and lower(cc.value::text) in ${sql(all)}
      and (cc.bounce_state in ('hard','spam') or cc.deleted_at is not null or c.is_spam or c.erased_at is not null or c.deleted_at is not null)
    union all select 1 from customers c where c.workspace_id=${workspaceId} and lower(c.email::text) in ${sql(all)}
      and (c.email_bounce_state in ('hard','spam') or c.is_spam or c.erased_at is not null or c.deleted_at is not null)
    limit 1` : [];
  return { source_message_id: source?.id || null, to, cc, in_reply_to: source?.external_message_id || null,
    sending_inboxes: sendingInboxes, default_sending_channel_id: defaultInbox?.id || null,
    default_from: branded?.fromEmail || env.POSTMARK_OUTBOUND_FROM || '',
    suppressed: !!recipient?.suppressed || !!blocked.length, can_send: !!recipient && !!to.length };
}
