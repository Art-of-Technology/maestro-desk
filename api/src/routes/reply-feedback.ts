import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../lib/db.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';

// Mounted inside the authenticated, rate-limited AI router.
export const replyFeedback = new Hono();
const Feedback = z.object({ helpful: z.boolean(),
  reason: z.enum(['wrong_match','outdated_advice','wrong_language','other']).nullable().default(null),
}).strict().refine(v => !v.helpful || v.reason === null);
const Status = z.enum(['open','in_progress','resolved']);
const Resolution = z.object({
  status: Status, owner_user_id: z.string().uuid().nullable(),
  root_cause: z.enum(['knowledge_gap','outdated_knowledge','wrong_match','language','generation','other']).nullable(),
  notes: z.string().trim().max(2000), version: z.number().int().min(0),
}).strict().refine(v => v.status !== 'resolved' || (!!v.root_cause && !!v.notes));

replyFeedback.patch('/:id/resolution', async c => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const body = Resolution.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !body.success) return c.json({error:'Choose a valid status and owner. Resolving feedback requires a cause and notes.'},400);
  const sql = getDb(), workspace = c.get('workspaceId'), input = body.data;
  const result = await sql.begin(async tx => {
    const [feedback] = await tx`select f.resolution_version from ai_reply_feedback f
      join ai_reply_suggestions s on s.id=f.suggestion_id
      where s.id=${id.data} and s.workspace_id=${workspace} and not f.helpful for update of f`;
    if (!feedback) return {status:404 as const,error:'Feedback not found.'};
    if (feedback.resolution_version !== input.version) return {status:409 as const,error:'This feedback changed. Refresh it before saving.'};
    if (input.owner_user_id) {
      const [owner] = await tx`select u.id from workspace_members wm
        join users u on u.id=wm.user_id and u.deleted_at is null
        where wm.workspace_id=${workspace} and wm.user_id=${input.owner_user_id} and wm.active for share of wm,u`;
      if (!owner) return {status:400 as const,error:'Choose an active member of this workspace.'};
    }
    await tx`update ai_reply_feedback f set resolution_status=${input.status},owner_user_id=${input.owner_user_id},
      root_cause=${input.root_cause},resolution_notes=${input.notes},resolution_updated_at=now(),
      resolution_updated_by=${c.get('userId')},resolution_version=resolution_version+1
      from ai_reply_suggestions s where f.suggestion_id=s.id and s.id=${id.data} and s.workspace_id=${workspace}`;
    return {ok:true};
  });
  return 'error' in result ? c.json({error:result.error},result.status) : c.json(result);
});

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

replyFeedback.post('/:id/rejected', async c => {
  const id=z.string().uuid().safeParse(c.req.param('id'));
  const body=z.object({rejected:z.boolean()}).strict().safeParse(await c.req.json().catch(()=>null));
  if(!id.success||!body.success)return c.json({error:'Choose whether to reject the suggestion.'},400);
  const sql=getDb();
  const rows=await sql`update ai_reply_suggestions set rejected_at=case when ${body.data.rejected} then coalesce(rejected_at,now()) else null end
    where id=${id.data} and workspace_id=${c.get('workspaceId')} and user_id=${c.get('userId')}
      and reply_context='reply' and sent_message_id is null returning rejected_at`;
  return rows.length?c.json({rejected:!!rows[0].rejected_at}):c.json({error:'This suggestion is unavailable or has already been used.'},404);
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
    on conflict(suggestion_id) do update set helpful=excluded.helpful,reason=excluded.reason,updated_at=now(),
      resolution_status=case when ai_reply_feedback.helpful is distinct from excluded.helpful
        or ai_reply_feedback.reason is distinct from excluded.reason then 'open' else ai_reply_feedback.resolution_status end,
      resolution_version=ai_reply_feedback.resolution_version+1
    returning helpful,reason`;
  if (!rows.length) return c.json({ error: 'This suggestion is no longer available to rate.' }, 404);
  return c.json(rows[0]);
});

replyFeedback.get('/', async c => {
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  const parsed = z.object({ offset: z.coerce.number().int().min(0).max(10000).default(0),
    status: z.enum(['open','in_progress','resolved','all']).default('open'),
  }).strict().safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid feedback page.' }, 400);
  const sql = getDb(), workspace = c.get('workspaceId');
  const rows = await sql`select s.id,s.reply,s.created_at,f.reason,f.updated_at,
      f.resolution_status,f.owner_user_id,f.root_cause,f.resolution_notes,f.resolution_updated_at,f.resolution_version,
      (select u.name from workspace_members wm join users u on u.id=wm.user_id and u.deleted_at is null
        where wm.workspace_id=${workspace} and wm.user_id=f.owner_user_id and wm.active) as owner_name,
      t.id as ticket_id,t.display_id,t.subject,
      coalesce((select jsonb_agg(jsonb_build_object('id',st.id,'display_id',st.display_id,'subject',st.subject) order by st.display_id)
        from ai_reply_suggestion_sources x join tickets st on st.id=x.ticket_id
        where x.suggestion_id=s.id and st.workspace_id=${workspace}), '[]'::jsonb) as sources
    from ai_reply_suggestions s join ai_reply_feedback f on f.suggestion_id=s.id
    join tickets t on t.id=s.ticket_id and t.workspace_id=s.workspace_id
    where s.workspace_id=${workspace} and f.helpful=false
      and (${parsed.data.status}='all' or f.resolution_status=${parsed.data.status})
    order by f.updated_at desc,s.id desc limit 26 offset ${parsed.data.offset}`;
  const owners = await sql`select u.id,u.name from workspace_members wm
    join users u on u.id=wm.user_id and u.deleted_at is null
    where wm.workspace_id=${workspace} and wm.active order by u.name,u.id`;
  return c.json({ items: rows.slice(0,25), hasMore: rows.length > 25, owners });
});
