import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspaceAdmin } from '../lib/authz.js';
import { getDb } from '../lib/db.js';
import { enforceRateLimit } from '../lib/rate-limit.js';
import { qualityFingerprint, qualitySignals, articleLinks, type QualityArticle } from '../lib/kb-quality.js';
import { checkKnowledgeLink } from '../lib/knowledge-import.js';

export const kbQuality = new Hono();
kbQuality.use('*',requireAuth);
kbQuality.use('*',async(c,next)=>{
  c.header('Cache-Control','no-store');
  const denied=await requireWorkspaceAdmin(c);if(denied)return denied;
  await next();
});
const Kind=z.enum(['thin','duplicate','promotion','overdue','links','broken_links','unverified_links']);
kbQuality.get('/',async c=>{
  const parsed=z.object({state:z.enum(['open','reviewed','dismissed']).default('open'),kind:Kind.optional(),offset:z.coerce.number().int().min(0).max(100000).default(0)}).safeParse(c.req.query());
  if(!parsed.success)return c.json({error:'Invalid queue filter'},400);
  const {state,kind,offset}=parsed.data,sql=getDb(),ws=c.get('workspaceId');
  const rows=await sql`select f.*,a.display_id,a.title,a.category,a.body,a.status,a.review_due_date,a.owner_user_id,
      u.name as owner_name
    from kb_quality_findings f join kb_articles a on a.id=f.article_id and a.workspace_id=f.workspace_id
    left join workspace_members wm on wm.workspace_id=a.workspace_id and wm.user_id=a.owner_user_id and wm.active
    left join users u on u.id=wm.user_id and u.deleted_at is null
    where f.workspace_id=${ws} and f.state=${state} and a.status<>'archived'
      ${kind?sql`and f.kind=${kind}`:sql``}
    order by f.detected_at desc,f.id limit 51 offset ${offset}`;
  const items=rows.slice(0,50).map(row=>{
    const {body,status,review_due_date,...item}=row;
    return {...item,stale:qualityFingerprint(row as QualityArticle)!==row.fingerprint};
  });
  return c.json({items,hasMore:rows.length>50});
});

kbQuality.post('/scan',async c=>{
  const parsed=z.object({after:z.string().uuid().nullable().default(null)}).strict().safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return c.json({error:'Invalid scan cursor'},400);
  const ws=c.get('workspaceId'),sql=getDb();
  const denied=await enforceRateLimit(c,{name:'kb-quality-scan',by:ws,max:30,windowSeconds:60,failClosed:true});if(denied)return denied;
  const rows=await sql`select id from kb_articles where workspace_id=${ws}
    and (${parsed.data.after}::uuid is null or id>${parsed.data.after}::uuid) order by id limit 51`;
  for(const row of rows.slice(0,50)) {
    await sql.begin(async tx=>{
      const [article]=await tx`select * from kb_articles where workspace_id=${ws} and id=${row.id} for update`;
      if(!article)return;
      const duplicates=await tx`select display_id from kb_articles where workspace_id=${ws} and category=${article.category}
        and md5(body)=md5(${article.body}) and body=${article.body} and id<>${article.id} and status<>'archived' order by id limit 5`;
      const fingerprint=qualityFingerprint(article as QualityArticle);
      const signals=qualitySignals({...article,duplicates:duplicates.map(d=>d.display_id)} as QualityArticle);
      const kinds=signals.map(s=>s.kind);
      await tx`delete from kb_quality_findings where workspace_id=${ws} and article_id=${article.id}
        and (fingerprint<>${fingerprint} or (kind not in ('broken_links','unverified_links') and not (kind=any(${kinds}::text[]))))`;
      for(const signal of signals) {
        await tx`insert into kb_quality_findings(workspace_id,article_id,fingerprint,kind,detail)
          values(${ws},${article.id},${fingerprint},${signal.kind},${signal.detail})
          on conflict(article_id,fingerprint,kind) do update set detail=excluded.detail`;
      }
    });
  }
  return c.json({scanned:Math.min(50,rows.length),next:rows.length>50?rows[49].id:null});
});

kbQuality.patch('/:id',async c=>{
  const id=z.string().uuid().safeParse(c.req.param('id'));
  const body=z.object({state:z.enum(['open','reviewed','dismissed']),note:z.string().trim().max(1000)}).strict().safeParse(await c.req.json().catch(()=>null));
  if(!id.success||!body.success)return c.json({error:'Choose a valid review status and a note up to 1000 characters.'},400);
  const sql=getDb(),ws=c.get('workspaceId');
  const result=await sql.begin(async tx=>{
    // Lock the article before touching findings, matching the scanner lock order.
    const [finding]=await tx`select f.fingerprint,a.* from kb_quality_findings f
      join kb_articles a on a.id=f.article_id and a.workspace_id=f.workspace_id
      where f.workspace_id=${ws} and f.id=${id.data} for update of a`;
    if(!finding)return 404;
    if(finding.status==='archived'||qualityFingerprint(finding as QualityArticle)!==finding.fingerprint)return 409;
    const changed=await tx`update kb_quality_findings set state=${body.data.state},note=${body.data.note},reviewed_by=${c.get('userId')},reviewed_at=now()
      where workspace_id=${ws} and id=${id.data} returning id`;
    return changed.length?200:409;
  });
  return result===200?c.json({ok:true}):c.json({error:result===404?'Finding not found':'Article changed. Scan articles again before recording a review.'},result as 404|409);
});

kbQuality.post('/:id/check-links',async c=>{
  const id=z.string().uuid().safeParse(c.req.param('id'));
  const body=z.object({offset:z.number().int().min(0).max(10000).default(0)}).strict().safeParse(await c.req.json().catch(()=>null));
  if(!id.success||!body.success)return c.json({error:'Invalid link check'},400);
  const ws=c.get('workspaceId'),sql=getDb();
  const denied=await enforceRateLimit(c,{name:'kb-quality-links',by:ws,max:6,windowSeconds:60,failClosed:true});if(denied)return denied;
  const [article]=await sql`select * from kb_articles where workspace_id=${ws} and id=${id.data} and status<>'archived'`;
  if(!article)return c.json({error:'Article not found'},404);
  const fingerprint=qualityFingerprint(article as QualityArticle),links=articleLinks(article.body);
  const selected=links.slice(body.data.offset,body.data.offset+3);
  if(!selected.length)return c.json({error:'No links in this batch. Scan articles again.'},400);
  const results=await Promise.all(selected.map(async(url)=>({url,result:await checkKnowledgeLink(url,ws)})));
  const saved=await sql.begin(async tx=>{
    const [current]=await tx`select * from kb_articles where workspace_id=${ws} and id=${id.data} for update`;
    if(!current||qualityFingerprint(current as QualityArticle)!==fingerprint)return false;
    for(const result of results) {
      // One finding per check batch; no untrusted response content is retained.
      if(result.result==='ok')continue;
      const kind=result.result==='broken'?'broken_links':'unverified_links';
      const detail=(result.result==='broken'?'Link returned HTTP 404 or 410: ':'Could not verify this link because of access, network or safety restrictions: ')+result.url;
      await tx`insert into kb_quality_findings(workspace_id,article_id,fingerprint,kind,detail)
        values(${ws},${id.data},${fingerprint},${kind},${detail})
        on conflict(article_id,fingerprint,kind) do update set state='open',detail=excluded.detail,detected_at=now(),note='',reviewed_at=null,reviewed_by=null`;
    }
    return true;
  });
  if(!saved)return c.json({error:'Article changed during the check. Scan articles again.'},409);
  return c.json({results,next:body.data.offset+3<links.length?body.data.offset+3:null,total:links.length});
});
