import { Hono } from 'hono';
import { z } from 'zod';
import type { TransactionSql, JSONValue } from 'postgres';
import { getDb } from '../lib/db.js';
import { sanitizeEmailHtml } from '../lib/email-html.js';

const metadata = z.record(z.unknown()).nullable().refine(v => JSON.stringify(v).length <= 50000);
const Input = z.object({
  version: z.number().int().min(0).max(2147483646),
  body: z.string().max(2000000),
  recipients: z.object({
    mode: z.enum(['reply', 'reply_all']), to: z.array(z.string().max(320)).max(100), cc: z.string().max(10000),
    source_message_id: z.string().uuid().nullable().optional(),
    sending_channel_id: z.string().uuid().nullable().optional(), sending_address: z.string().max(320).nullable().optional(),
    ticket_channel_id: z.string().uuid().nullable().optional(),
  }).strict().nullable(),
  review: metadata,
}).strict();

export class DraftConflict extends Error {}

// Called in the message transaction: either the message and clear both commit or neither does.
export async function consumeDraft(sql: TransactionSql, workspace: string, user: string, ticket: string, tab: string, version: number) {
  const [saved] = await sql`update message_drafts set body='', recipients=null, review=null, version=version+1
    where workspace_id=${workspace} and user_id=${user} and ticket_id=${ticket} and compose_tab=${tab} and version=${version}
    returning version`;
  if (!saved) throw new DraftConflict('Your draft changed on another device. Reopen it before sending.');
  return saved.version as number;
}

// Auth and workspace membership are enforced by the parent tickets router.
export const messageDrafts = new Hono();
messageDrafts.use('/:id/drafts/:tab', async (c, next) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success || !['reply', 'note'].includes(c.req.param('tab') || '')) {
    return c.json({ error: 'Draft not found' }, 404);
  }
  const [ticket] = await getDb()`select id from tickets where id=${c.req.param('id')}
    and workspace_id=${c.get('workspaceId')} and deleted_at is null`;
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  c.header('Cache-Control', 'no-store');
  await next();
});
messageDrafts.get('/:id/drafts/:tab', async c => {
  const [draft] = await getDb()`select body, recipients, review, version from message_drafts
    where workspace_id=${c.get('workspaceId')} and user_id=${c.get('userId')}
      and ticket_id=${c.req.param('id')} and compose_tab=${c.req.param('tab')}`;
  return c.json({ draft: draft || { body: '', recipients: null, review: null, version: 0 } });
});
messageDrafts.put('/:id/drafts/:tab', async c => {
  const parsed = Input.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid draft' }, 400);
  const input = parsed.data, tab = c.req.param('tab');
  if (tab === 'note' && (input.recipients || input.review)) return c.json({ error: 'Notes cannot have reply details.' }, 400);
  const body = tab === 'reply' ? sanitizeEmailHtml(input.body, { allowDataImages: true }).html : input.body;
  const result = await getDb().begin(async sql => {
    // Also recheck the ticket inside the write transaction against concurrent deletion.
    const [ticket] = await sql`select id from tickets where id=${c.req.param('id')}
      and workspace_id=${c.get('workspaceId')} and deleted_at is null for update`;
    if (!ticket) return null;
    await sql`insert into message_drafts(workspace_id,user_id,ticket_id,compose_tab,body)
      values (${c.get('workspaceId')},${c.get('userId')},${ticket.id},${tab},'')
      on conflict (user_id,ticket_id,compose_tab) do nothing`;
    const [saved] = await sql`update message_drafts set body=${body}, recipients=${input.recipients ? sql.json(input.recipients) : null},
      review=${input.review ? sql.json(input.review as JSONValue) : null}, version=version+1
      where workspace_id=${c.get('workspaceId')} and user_id=${c.get('userId')} and ticket_id=${ticket.id}
        and compose_tab=${tab} and version=${input.version}
      returning body,recipients,review,version`;
    return saved || false;
  });
  if (result === null) return c.json({ error: 'Ticket not found' }, 404);
  if (!result) return c.json({ error: 'Draft changed on another device. Choose which copy to keep.' }, 409);
  return c.json({ draft: result });
});
