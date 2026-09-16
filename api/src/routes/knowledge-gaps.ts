import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { getDb } from '../lib/db.js';
import { enforceRateLimit } from '../lib/rate-limit.js';
import { gapGroups, type GapTicket } from '../lib/knowledge-gaps.js';

export const knowledgeGaps = new Hono();
knowledgeGaps.use('*', requireAuth);
knowledgeGaps.use('*', async (c,next) => {
  c.header('Cache-Control','no-store');
  const denied = await requireWorkspaceAdmin(c);
  if (denied) return denied;
  await next();
});
const State = z.enum(['open','in_progress','resolved','dismissed']);

knowledgeGaps.get('/', async c => {
  const parsed = z.object({ state: State.default('open'), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict().safeParse(c.req.query());
  if (!parsed.success) return c.json({error:'Choose a valid queue page.'},400);
  const sql = getDb(), ws = c.get('workspaceId');
  const rows = await sql`select g.*,a.display_id as article_display_id,a.title as article_title,a.status as article_status,
    coalesce((select jsonb_agg(x order by x.display_id) from (
      select t.id,t.display_id,t.subject,gt.signal from kb_knowledge_gap_tickets gt
      join tickets t on t.id=gt.ticket_id and t.workspace_id=g.workspace_id
      join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
      where gt.gap_id=g.id and t.deleted_at is null and t.merged_into_id is null
        and c.deleted_at is null and c.erased_at is null
        and t.category_key is not distinct from g.category and c.brand is not distinct from g.brand
        and c.jurisdiction is not distinct from g.market
      order by t.display_id limit 20) x),'[]'::jsonb) as tickets
    from kb_knowledge_gaps g left join kb_articles a on a.id=g.article_id and a.workspace_id=g.workspace_id
    where g.workspace_id=${ws} and g.state=${parsed.data.state}
    order by g.scanned_at desc,g.id desc limit 26 offset ${parsed.data.offset}`;
  return c.json({items:rows.slice(0,25),hasMore:rows.length>25});
});

knowledgeGaps.post('/scan', async c => {
  if (!z.object({}).strict().safeParse(await c.req.json().catch(()=>null)).success) return c.json({error:'Invalid scan request.'},400);
  const ws = c.get('workspaceId');
  const denied = await enforceRateLimit(c,{name:'knowledge-gap-scan',by:ws,max:6,windowSeconds:60,failClosed:true});
  if (denied) return denied;
  const sql = getDb();
  const result = await sql.begin(async tx => {
    const rows = await tx`select t.id,t.category_key,c.brand,c.jurisdiction,
      (t.status_key not in ('resolved','closed') and exists(select 1 from ticket_messages m
        where m.ticket_id=t.id and m.workspace_id=${ws} and m.role='customer' and m.deleted_at is null
          and m.created_at>coalesce((select max(a.created_at) from ticket_messages a where a.ticket_id=t.id
            and a.workspace_id=${ws} and a.role in ('agent','ai') and a.deleted_at is null),'-infinity'::timestamptz))) as unanswered,
      exists(select 1 from ai_reply_suggestions s join ai_reply_feedback f on f.suggestion_id=s.id
        where s.workspace_id=${ws} and s.ticket_id=t.id and s.created_at>=now()-interval '30 days'
          and not f.helpful and f.resolution_status<>'resolved') as weak
      from tickets t join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
      where t.workspace_id=${ws} and t.deleted_at is null and t.merged_into_id is null
        and c.deleted_at is null and c.erased_at is null and t.updated_at>=now()-interval '30 days'
      order by t.updated_at desc,t.id desc limit 501 for share of t,c`;
    const groups = gapGroups(rows.slice(0,500) as GapTicket[]);
    for (const group of groups.slice(0,50).sort((a,b)=>a.key.localeCompare(b.key))) {
      const [gap] = await tx`insert into kb_knowledge_gaps(workspace_id,group_key,category,brand,market)
        values(${ws},${group.key},${group.category},${group.brand},${group.market})
        on conflict(workspace_id,group_key) do update set scanned_at=now(),version=kb_knowledge_gaps.version+1 returning id`;
      await tx`delete from kb_knowledge_gap_tickets where gap_id=${gap.id}`;
      const links = group.tickets.map(ticket => ({gap_id:gap.id,ticket_id:ticket.id,
        signal:ticket.unanswered ? ticket.weak?'both':'unanswered':'negative_feedback'}));
      await tx`insert into kb_knowledge_gap_tickets ${tx(links,'gap_id','ticket_id','signal')}`;
    }
    return {scanned:Math.min(rows.length,500),groups:Math.min(groups.length,50),limited:rows.length>500||groups.length>50};
  });
  return c.json(result);
});

knowledgeGaps.patch('/:id', async c => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const body = z.object({state:State,article_display_id:z.string().trim().max(80),note:z.string().trim().max(2000),version:z.number().int().min(0)})
    .strict().refine(v=>v.state!=='resolved'||(!!v.article_display_id&&!!v.note)).safeParse(await c.req.json().catch(()=>null));
  if (!id.success || !body.success) return c.json({error:'Choose a valid state. Resolving requires an article ID and a note.'},400);
  const sql = getDb(), ws = c.get('workspaceId'), input = body.data;
  const result = await sql.begin(async tx => {
    // Article-first locking also matches article deletion / FK cleanup.
    let articleId:string|null = null;
    if (input.article_display_id) {
      const [article] = await tx`select id from kb_articles where workspace_id=${ws} and display_id=${input.article_display_id}
        and status<>'archived' for share`;
      if (!article) return {status:400 as const,error:'Choose an existing, non-archived article in this workspace.'};
      articleId = article.id;
    }
    const [gap] = await tx`select version from kb_knowledge_gaps where id=${id.data} and workspace_id=${ws} for update`;
    if (!gap) return {status:404 as const,error:'Knowledge gap not found.'};
    if (gap.version!==input.version) return {status:409 as const,error:'The gap changed. Refresh before saving.'};
    await tx`update kb_knowledge_gaps set state=${input.state},article_id=${articleId},note=${input.note},updated_at=now(),version=version+1
      where id=${id.data} and workspace_id=${ws}`;
    return {ok:true};
  });
  return 'error' in result ? c.json({error:result.error},result.status) : c.json(result);
});
