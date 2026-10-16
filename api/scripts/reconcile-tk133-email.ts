import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';
import { safeError } from '../src/lib/diagnostics.js';

export const sends = [
  { createdAt: '2026-10-16T13:42:15.542Z', providerId: '2e1bf649-38f0-4171-a298-076f814eb2f9' },
  { createdAt: '2026-10-16T16:29:01.247Z', providerId: 'c88bd9d9-9539-4264-9f36-7f0339882bcd' },
] as const;
const marker = 'tk133-delivery-20261016';
const Address = z.object({ Email: z.string().email() });
const ProviderMessage = z.object({
  MessageID: z.string().uuid(), Subject: z.literal('Re: (no subject)'), From: z.string(),
  ReceivedAt: z.string().datetime({ offset: true }), Sandboxed: z.literal(false),
  MessageStream: z.literal('outbound'), TextBody: z.string().min(1), HtmlBody: z.string().min(1),
  To: z.array(Address).min(1), Cc: z.array(Address), Bcc: z.array(Address).length(0),
  MessageEvents: z.array(z.object({ Type: z.string(), Recipient: z.string().email(),
    ReceivedAt: z.string().datetime({ offset: true }) })),
});
const Envelope = z.object({
  from: z.string().email(), to: z.array(z.string().email()).min(1), cc: z.array(z.string().email()),
  status: z.string(), delivery_state: z.string().optional(),
  postmark_message_id: z.string().optional(), delivery_repair: z.object({ marker: z.string() }).optional(),
  delivered_recipients: z.record(z.string()).optional(),
});
type Message = { body: string; body_html: string | null; external_message_id: string | null;
  email_metadata: unknown; sent_email: { subject: string; text: string; html: string | null } | null };

export function matchReceipt(message: Message, raw: unknown, dump: unknown, send: typeof sends[number]) {
  const provider = ProviderMessage.parse(raw), envelope = Envelope.parse(message.email_metadata);
  const fail = () => { throw Error(`Receipt mismatch for approved send ${send.providerId}`); };
  const sameAddresses = (a: string[], b: string[]) => JSON.stringify(a.map(v => v.toLowerCase()).sort()) === JSON.stringify(b.map(v => v.toLowerCase()).sort());
  const from = provider.From.match(/<([^<>]+)>$/)?.[1] || provider.From;
  if (provider.MessageID !== send.providerId || Math.abs(Date.parse(provider.ReceivedAt) - Date.parse(send.createdAt)) > 5000
    || from.toLowerCase() !== envelope.from.toLowerCase()
    || !sameAddresses(envelope.to, provider.To.map(v => v.Email)) || !sameAddresses(envelope.cc, provider.Cc.map(v => v.Email))) fail();
  if (message.sent_email) {
    if (provider.Subject !== message.sent_email.subject || provider.TextBody !== message.sent_email.text || provider.HtmlBody !== message.sent_email.html) fail();
  } else if (!message.body.trim() || !message.body_html?.trim()
    || !provider.TextBody.includes(message.body) || !provider.HtmlBody.includes(message.body_html)) fail();
  const source = z.object({ Body: z.string().min(1) }).parse(dump).Body.split(/\r?\n\r?\n/, 1)[0];
  const ids = [...source.matchAll(/^Message-ID:[ \t]*(<[^<>\s]+@[^<>\s]+>)[ \t]*\r?$/gmi)];
  if (ids.length !== 1) fail();
  const rfcMessageId = ids[0][1];
  if (message.external_message_id && message.external_message_id !== rfcMessageId) fail();
  const recipients = [...new Set([...envelope.to, ...envelope.cc].map(v => v.toLowerCase()))];
  const delivered: Record<string, string> = {};
  for (const recipient of recipients) {
    const events = provider.MessageEvents.filter(e => e.Recipient.toLowerCase() === recipient);
    const receipt = events.find(e => e.Type === 'Delivered');
    if (!receipt || events.some(e => e.Type === 'Bounced')) fail();
    delivered[recipient] = receipt!.ReceivedAt;
  }
  const alreadyRepaired = envelope.delivery_repair?.marker === marker && envelope.status === 'sent'
    && envelope.postmark_message_id === provider.MessageID && envelope.delivery_state === 'sent'
    && message.external_message_id === rfcMessageId
    && recipients.every(recipient => envelope.delivered_recipients?.[recipient] === delivered[recipient]);
  if (!alreadyRepaired && (envelope.status !== 'saved' || message.external_message_id
    || (envelope.delivery_state && envelope.delivery_state !== 'unknown'))) fail();
  return { provider, delivered, rfcMessageId, alreadyRepaired };
}

export async function reconcileTk133(sql: Sql, fetchProvider: (id: string) => Promise<{ details: unknown; dump: unknown }>, apply = false, confirm?: string) {
  // Fetch only the two explicitly approved provider IDs; this script never sends mail.
  const evidence = await Promise.all(sends.map(send => fetchProvider(send.providerId)));
  return sql.begin(async tx => {
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='30s'`;
    const [workspace] = await tx`select id from workspaces where slug='spacecasino' and deleted_at is null and suspended_at is null for share`;
    if (!workspace) throw Error('Approved workspace is unavailable');
    const [customer] = await tx`select c.id from customers c join tickets t on t.customer_id=c.id and t.workspace_id=c.workspace_id
      where t.workspace_id=${workspace.id} and t.display_id='TK-133' and c.display_id='M76'
        and c.deleted_at is null and c.erased_at is null for share of c`;
    const [ticket] = await tx`select id from tickets where workspace_id=${workspace.id} and display_id='TK-133'
      and customer_id=${customer?.id ?? null} and subject='(no subject)' and deleted_at is null and merged_into_id is null for update`;
    if (!ticket) throw Error('Approved ticket is unavailable');
    const rows = await tx`select * from ticket_messages where workspace_id=${workspace.id} and ticket_id=${ticket.id}
      and created_at=any(${sends.map(s => s.createdAt)}::timestamptz[]) and role='agent' and deleted_at is null
      and body<>'[erased]' and merged_from_id is null and cardinality(forwarded_from_ticket_ids)=0 order by created_at for update`;
    if (rows.length !== 2) throw Error('Expected exactly two approved message rows');
    const matches = sends.map((send, i) => {
      const row = rows.find(r => new Date(r.created_at).toISOString() === send.createdAt);
      if (!row) throw Error('Approved message timestamp changed');
      const matched = matchReceipt(row as Message, evidence[i].details, evidence[i].dump, send);
      // A full body match must identify just one of the two local messages.
      const matchingBodies = rows.filter(r => r.sent_email
        ? r.sent_email.text === matched.provider.TextBody && r.sent_email.html === matched.provider.HtmlBody
        : r.body.trim() && r.body_html?.trim() && matched.provider.TextBody.includes(r.body) && matched.provider.HtmlBody.includes(r.body_html));
      if (matchingBodies.length !== 1 || matchingBodies[0].id !== row.id) throw Error('Ambiguous email content');
      return { row, ...matched };
    });
    const snapshotHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    if (apply && matches.some(m => !m.alreadyRepaired) && confirm !== snapshotHash) throw Error('Message snapshot changed or dry-run confirmation is missing');
    for (const match of matches) {
      if (!apply || match.alreadyRepaired) continue;
      const { row, provider, delivered, rfcMessageId } = match;
      await tx`update ticket_messages set external_message_id=${rfcMessageId},
        email_metadata=(email_metadata - 'retry_recipients') || ${sql.json({ status:'sent',delivery_state:'sent',
          sent_at:provider.ReceivedAt,postmark_message_id:provider.MessageID,delivered_recipients:delivered,
          delivery_repair:{marker,repaired_at:new Date().toISOString(),previous_email_metadata:row.email_metadata,
            previous_external_message_id:row.external_message_id} })}
        where workspace_id=${workspace.id} and ticket_id=${ticket.id} and id=${row.id}`;
    }
    return { mode:apply ? 'apply' : 'dry-run', ticket:'TK-133', snapshotHash, rows:matches.map(m => ({ messageId:m.row.id,
      providerId:m.provider.MessageID,alreadyRepaired:m.alreadyRepaired,deliveredRecipients:Object.keys(m.delivered).length })) };
  });
}

async function main() {
  const {values} = parseArgs({options:{apply:{type:'boolean',default:false},confirm:{type:'string'}}});
  if (values.confirm && (!values.apply || !/^[a-f0-9]{64}$/.test(values.confirm))) throw Error('Use --apply --confirm with the dry-run fingerprint');
  const url = process.env.DATABASE_URL, token = process.env.POSTMARK_SERVER_TOKEN;
  if (!url || !token) throw Error('Operator DATABASE_URL and POSTMARK_SERVER_TOKEN are required');
  const sql = postgres(url, { max:1,prepare:false,ssl:url.includes('sslmode=disable') ? false : 'require',onnotice:()=>{} });
  try {
    console.log(JSON.stringify(await reconcileTk133(sql, async id => {
      const read = async (suffix: string) => {
        const response = await fetch(`https://api.postmarkapp.com/messages/outbound/${id}/${suffix}`, {
          headers:{'X-Postmark-Server-Token':token},signal:AbortSignal.timeout(15000),redirect:'error' });
        if (!response.ok) throw Error(`Postmark evidence unavailable (HTTP ${response.status})`);
        return response.json();
      };
      const [details,dump] = await Promise.all([read('details'),read('dump')]);
      return {details,dump};
    }, values.apply, values.confirm)));
  } finally { await sql.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error('TK-133 repair refused or failed. No automatic retry; inspect records before proceeding.',safeError(error)); process.exitCode=1; });
}
