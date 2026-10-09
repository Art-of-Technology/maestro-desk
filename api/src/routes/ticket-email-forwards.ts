import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { getDb } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { loadTicketEmails } from '../lib/ticket-emails.js';
import type { ExportAttachment } from '../lib/email-export.js';
import { cleanEmails, hasSuppressedRecipients } from '../lib/email-recipients.js';
import { getSendingInboxes, getOutboundFrom } from '../lib/outbound-from.js';
import { env } from '../lib/env.js';
import { composeEmail, textToHtml } from '../lib/email-branding.js';
import { sanitizeEmailHtml } from '../lib/email-html.js';
import { MAX_HTML_CHARS } from '../lib/html-text.js';
import { sendBrandedEmail } from '../lib/send-branded-email.js';
import { sentEmailContent } from '../lib/sent-email.js';
import { resolveTicketReplyTo } from '../lib/ticket-reply-to.js';
import { attachmentsStore, contentDispositionFor } from '../lib/r2.js';
import { storageKeyFor, loadAttachmentsForTicket, decorateMessages } from '../lib/message-attachments.js';
import { MAX_REPLY_ATTACHMENT_BYTES, MAX_INBOUND_FILE_COUNT, classifyAttachment } from '../lib/attachment-policy.js';
import { enqueueObjectDeletions, drainObjectDeletions } from '../lib/object-outbox.js';
import { enforceRateLimit } from '../lib/rate-limit.js';
import { safeError } from '../lib/diagnostics.js';

export const ticketEmailForwards = new Hono();
const address = z.string().trim().email().max(254);
const Forward = z.object({
  request_id: z.string().uuid(), source_version: z.string().regex(/^[a-f0-9]{64}$/),
  to: z.array(address).min(1).max(50), cc: z.array(address).max(49),
  subject: z.string().trim().min(1).max(500).regex(/^[^\r\n]+$/),
  message: z.string().max(20000), attachment_ids: z.array(z.string().uuid()).max(MAX_INBOUND_FILE_COUNT),
  sending_channel_id: z.string().uuid().nullable(), sending_address: address.nullable(),
}).strict();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Loaded = Awaited<ReturnType<typeof loadTicketEmails>>;
const sourceVersion = (source: Loaded) => digest([source.emails, source.attachments, source.privacy, source.generation]);

function content(source: Loaded, comment: string, ids: Map<string, string>) {
  const email = source.emails[0], saved = email.sent_email, meta = email.email_metadata;
  const subject = saved?.subject || email.subject;
  const headers = ['---------- Forwarded email ----------', `From: ${meta?.from || email.author_label || 'Not saved'}`,
    `Date: ${new Date(meta?.sent_at || meta?.received_at || email.created_at).toUTCString()}`,
    `Subject: ${subject}`, `To: ${meta?.to?.join(', ') || 'Not saved'}`,
    ...(meta?.cc?.length ? [`Cc: ${meta.cc.join(', ')}`] : [])].join('\n');
  const raw = saved?.html || email.body_html;
  if (raw && raw.length > MAX_HTML_CHARS) throw new HTTPException(413, {message:'This email is too large to forward.'});
  const html = raw ? sanitizeEmailHtml(raw, {cidMap: ids}).html : textToHtml(saved?.text || email.body);
  return { text: [comment, headers, saved?.text || email.body].filter(Boolean).join('\n\n'),
    html: `${comment ? `<div>${textToHtml(comment)}</div><br>` : ''}<div>${textToHtml(headers)}</div><br>${html}` };
}

ticketEmailForwards.get('/:id/emails/:messageId/forward', async c => {
  const params = z.object({id:z.string().uuid(),messageId:z.string().uuid()}).safeParse(c.req.param());
  if (!params.success) return c.json({error:'Choose a valid ticket email.'},400);
  const {id, messageId} = params.data;
  const ws = c.get('workspaceId');
  const source = await loadTicketEmails(ws,id,messageId);
  const email = source.emails[0];
  const ids = new Map(source.attachments.filter(a=>a.is_inline).map(a=>[a.id,a.id]));
  const original = content(source,'',ids);
  const [preview] = decorateMessages([{id:email.id,body_html:original.html}], await loadAttachmentsForTicket(ws,email.ticket_id));
  const [ticket] = await getDb()`select channel_id from tickets where workspace_id=${ws} and id=${id}`;
  const inboxes = await getSendingInboxes(ws);
  await source.requireCurrent();
  await requireAuth(c,async()=>{});
  c.header('Cache-Control','private, no-store');
  return c.json({source_version:sourceVersion(source),subject:`Fwd: ${(email.sent_email?.subject || email.subject).replace(/^fwd:\s*/i,'')}`,
    original:{text:original.text,html:preview.body_html},
    attachments:preview.attachments, sending_inboxes:inboxes,
    default_sending_channel_id:inboxes.find(i=>i.id===ticket?.channel_id)?.id || null,
    default_from:(await getOutboundFrom(ws))?.fromEmail || env.POSTMARK_OUTBOUND_FROM || ''});
});

ticketEmailForwards.post('/:id/emails/:messageId/forward', async c => {
  const params = z.object({id:z.string().uuid(),messageId:z.string().uuid()}).safeParse(c.req.param());
  const parsed = Forward.safeParse(await c.req.json().catch(()=>null));
  if (!params.success || !parsed.success) return c.json({error:'Check the forwarding recipients, subject and attachments.'},400);
  const ws=c.get('workspaceId'), user=c.get('userId'), {id,messageId}=params.data, input=parsed.data, sql=getDb();
  const limited=await enforceRateLimit(c,{name:'ticket-forward',by:`${ws}:${user}`,max:10,windowSeconds:60,failClosed:true});
  if (limited) return limited;
  const source=await loadTicketEmails(ws,id,messageId);
  if (sourceVersion(source)!==input.source_version) return c.json({error:'The original email changed. Reopen Forward to review it.'},409);
  const to=cleanEmails(input.to), cc=cleanEmails(input.cc).filter(e=>!to.includes(e));
  if (to.length+cc.length>50) return c.json({error:'Use no more than 50 recipients.'},400);
  const [channels, branded, inboxes] = await Promise.all([
    sql`select address from channels where workspace_id=${ws} and type='email'`,getOutboundFrom(ws),getSendingInboxes(ws)]);
  const own=new Set(cleanEmails([...channels.map(r=>r.address),branded?.fromEmail,env.POSTMARK_OUTBOUND_FROM,env.POSTMARK_INBOUND_REPLY_ADDRESS]));
  if ([...to,...cc].some(e=>own.has(e) || e.endsWith('@inbound.postmarkapp.com'))) return c.json({error:'Choose recipients outside the ticket receiving inboxes.'},400);
  if (await hasSuppressedRecipients(ws,[...to,...cc])) return c.json({error:'A recipient is unavailable or blocked from receiving email.'},422);
  const inbox=inboxes.find(i=>i.id===input.sending_channel_id && i.address===input.sending_address?.toLowerCase());
  if (input.sending_channel_id && !inbox) return c.json({error:'The sending inbox changed. Choose another From inbox.'},409);
  const files=source.attachments.filter(a=>input.attachment_ids.includes(a.id));
  if (new Set(input.attachment_ids).size!==files.length) return c.json({error:'An attachment does not belong to this email.'},400);
  if (files.reduce((n,a)=>n+(a.size_bytes||0),0)>MAX_REPLY_ATTACHMENT_BYTES) return c.json({error:'Selected attachments exceed 7 MB. Remove some files before forwarding.'},413);
  const hash=digest(input);
  const [author]=await sql`select name,email from users where id=${user}`;
  const origins=[...new Set([source.emails[0].ticket_id,...(source.emails[0].forwarded_from_ticket_ids || [])])];
  const meta={status:'saved',from:inbox?.address || branded?.fromEmail || env.POSTMARK_OUTBOUND_FROM || '',to,cc,
    forward_state:'preparing',request_hash:hash,source_message_id:source.emails[0].id};
  const [claimed]=await sql`insert into ticket_messages(id,workspace_id,ticket_id,role,author_user_id,author_label,body,email_metadata,forwarded_from_ticket_ids)
    values(${input.request_id},${ws},${id},'agent',${user},${author?.name || author?.email || 'Agent'},${input.message || '(Forwarded email)'},${sql.json(meta)},${origins})
    on conflict(id) do nothing returning id`;
  if (!claimed) {
    const [existing]=await sql`select email_metadata from ticket_messages where workspace_id=${ws} and ticket_id=${id} and id=${input.request_id} and author_user_id=${user} and deleted_at is null`;
    if (existing?.email_metadata?.request_hash===hash && existing.email_metadata.status==='sent') return c.json({sent:true});
    return c.json({error:'This forwarding attempt has already started. Check the ticket before sending again.'},409);
  }
  const orphanKeys: string[]=[];
  let attempted=false;
  try {
    const ids=new Map(files.map(a=>[a.id,crypto.randomUUID()]));
    const forwarded=content(source,input.message,ids);
    const composed=await composeEmail({workspaceId:ws,authorUserId:user,bodyText:forwarded.text,bodyHtml:forwarded.html});
    if ((composed.html?.length || 0)>MAX_HTML_CHARS) throw new HTTPException(413,{message:'This email is too large to forward.'});
    let total=Buffer.byteLength(composed.text)+Buffer.byteLength(composed.html || '');
    const outgoing=[];
    const copied: ExportAttachment[]=[];
    for (const file of files) {
      const {bytes}=await attachmentsStore().getObject(file.storage_key);
      total+=Math.ceil(bytes.byteLength/3)*4;
      if (total>9*1024*1024) throw new HTTPException(413,{message:'This email and its attachments are too large to forward. Remove some files.'});
      const verdict=classifyAttachment(file.filename,file.mime_type,bytes,MAX_REPLY_ATTACHMENT_BYTES);
      if (!verdict.ok) throw new HTTPException(422,{message:'An attachment cannot be forwarded. Remove it and try again.'});
      const attachmentId=ids.get(file.id)!;
      const key=storageKeyFor(ws,id,attachmentId,file.filename);
      orphanKeys.push(key);
      await attachmentsStore().putObject(key,bytes,{contentType:verdict.mime,contentDisposition:contentDispositionFor(file.is_inline?'inline':'attachment',file.filename)});
      copied.push({...file,id:attachmentId,storage_key:key,size_bytes:bytes.byteLength,mime_type:verdict.mime});
      outgoing.push({Name:file.filename,Content:Buffer.from(bytes).toString('base64'),ContentType:verdict.mime,ContentID:file.is_inline?`cid:${attachmentId}`:undefined});
    }
    await source.requireCurrent();
    // The original message may have been removed while attachment bytes loaded.
    if (sourceVersion(await loadTicketEmails(ws,id,messageId))!==input.source_version) throw new HTTPException(409,{message:'The original email changed. Reopen Forward to review it.'});
    await requireAuth(c,async()=>{});
    await sql.begin(async tx=>{
      await tx`update ticket_messages set body=${forwarded.text},body_html=${composed.html},email_metadata=${tx.json({...meta,forward_state:'sending'})}
        where workspace_id=${ws} and id=${input.request_id}`;
      for (const file of copied) await tx`insert into ticket_attachments(id,workspace_id,ticket_id,message_id,filename,storage_key,size_bytes,mime_type,is_inline,disposition)
        values(${file.id},${ws},${id},${input.request_id},${file.filename},${file.storage_key},${file.size_bytes},${file.mime_type},${file.is_inline},${file.is_inline?'inline':'attachment'})`;
    });
    orphanKeys.length=0;
    attempted=true;
    const replyTo=inbox?.address || await resolveTicketReplyTo(ws,id);
    const result=await sendBrandedEmail({workspaceId:ws,accessGeneration:source.generation,privacy:source.privacy,
      sendingChannelId:input.sending_channel_id,expectedSendingAddress:input.sending_address,
      to:to.join(','),cc:cc.join(','),subject:input.subject,textBody:composed.text,htmlBody:composed.html,
      replyTo,attachments:outgoing});
    await sql`update ticket_messages set external_message_id=${result.rfcMessageId},sent_email=${sql.json(sentEmailContent(composed,input.subject))},
      email_metadata=${sql.json({...meta,status:'sent',forward_state:'sent',from:result.fromEmail,sent_at:result.submittedAt,reply_to:replyTo,used_fallback_from:result.usedFallbackFrom})}
      where workspace_id=${ws} and id=${input.request_id}`;
    return c.json({sent:true},201);
  } catch(error) {
    console.warn('[email-forward] failed:',safeError(error));
    await sql`update ticket_messages set email_metadata=${sql.json({...meta,forward_state:attempted?'unknown':'failed'})}
      where workspace_id=${ws} and id=${input.request_id} and body <> '[erased]'`.catch(()=>{});
    return c.json({error:attempted?'Delivery could not be confirmed. Check the ticket before forwarding again.':
      error instanceof HTTPException?error.message:'The forward was not sent. Check attachments and try again.',retryable:!attempted},attempted?502:503);
  } finally {
    if (orphanKeys.length) { await enqueueObjectDeletions(sql,orphanKeys,'orphan'); await drainObjectDeletions(orphanKeys); }
  }
});
