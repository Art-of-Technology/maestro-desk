import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';

// Mounted inside the authenticated, rate-limited AI router.
export const replyFeedback = new Hono();
const Feedback = z.object({ helpful: z.boolean(),
  reason: z.enum(['wrong_match','outdated_advice','wrong_language','other']).nullable().default(null),
}).strict().refine(v => !v.helpful || v.reason === null);

replyFeedback.post('/:id/shown', async c => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success || !z.object({}).strict().safeParse(await c.req.json().catch(() => null)).success)
    return c.json({ error: 'Invalid suggestion event.' }, 400);
  const sql = getDb();
  const rows = await sql`update ai_reply_suggestions set shown_at=coalesce(shown_at,now())
    where id=${id.data} and workspace_id=${c.get('workspaceId')} and user_id=${c.get('userId')}
      and reply_context='reply' returning id`;
  return rows.length ? c.json({ok:true}) : c.json({error:'Suggestion not found.'},404);
});

replyFeedback.post('/:id', async c => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const body = Feedback.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !body.success) return c.json({ error: 'Choose Helpful or Not helpful and a valid reason.' }, 400);
  const sql = getDb();
  // The generation's owner and workspace come from the server, never the body.
  const rows = await sql`insert into ai_reply_feedback(suggestion_id,helpful,reason)
    select s.id,${body.data.helpful},${body.data.reason} from ai_reply_suggestions s
    where s.id=${id.data} and s.workspace_id=${c.get('workspaceId')} and s.user_id=${c.get('userId')}
    on conflict(suggestion_id) do update set helpful=excluded.helpful,reason=excluded.reason,updated_at=now()
    returning helpful,reason`;
  if (!rows.length) return c.json({ error: 'This suggestion is no longer available to rate.' }, 404);
  return c.json(rows[0]);
});

replyFeedback.get('/', async c => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const parsed = z.object({ offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict().safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid feedback page.' }, 400);
  const sql = getDb(), workspace = c.get('workspaceId');
  const rows = await sql`select s.id,s.reply,s.created_at,f.reason,f.updated_at,
      t.id as ticket_id,t.display_id,t.subject,
      coalesce((select jsonb_agg(jsonb_build_object('id',st.id,'display_id',st.display_id,'subject',st.subject) order by st.display_id)
        from ai_reply_suggestion_sources x join tickets st on st.id=x.ticket_id
        where x.suggestion_id=s.id and st.workspace_id=${workspace}), '[]'::jsonb) as sources
    from ai_reply_suggestions s join ai_reply_feedback f on f.suggestion_id=s.id
    join tickets t on t.id=s.ticket_id and t.workspace_id=s.workspace_id
    where s.workspace_id=${workspace} and f.helpful=false
    order by f.updated_at desc,s.id desc limit 26 offset ${parsed.data.offset}`;
  return c.json({ items: rows.slice(0,25), hasMore: rows.length > 25 });
});
