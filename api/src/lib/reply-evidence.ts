import { getDb } from './db.js';
import type { ReplySource } from './customer-reply.js';
import type { ReplyExample } from './previous-replies.js';

export function knowledgeReference(a: Record<string, any>, today=new Date().toISOString().slice(0,10)): ReplySource {
  const warnings=[];
  if(a.changes_pending)warnings.push('The source has unpublished changes.');
  if(a.error)warnings.push('The latest source refresh failed.');
  if(a.review_due_date && a.review_due_date<today)warnings.push('This article is overdue for review.');
  const locale=/^(?:Games|Website) · ([a-z]{2}(?:-[a-z]{2})?)$/.exec(a.category||'')?.[1];
  const date=a.updated_at?new Date(a.updated_at):null;
  return {id:String(a.display_id),title:String(a.title),kind:'article',entityId:String(a.id),
    ...(date && Number.isFinite(date.getTime())?{datedAt:date.toISOString()}:{}),
    ...(a.jurisdiction||locale?{market:String(a.jurisdiction||locale).slice(0,100)}:{}),
    ...(a.language?{language:String(a.language).slice(0,100)}:{}),warnings,
    ...(a.locator && /^https?:\/\//i.test(a.locator)?{url:String(a.locator)}:{}),
  };
}

export async function historicalReferences(workspaceId:string,examples:ReplyExample[],target:{brand:string|null;jurisdiction:string|null}):Promise<ReplySource[]> {
  if(!examples.length)return [];
  const sql=getDb();
  const rows=await sql`select m.id,m.created_at,t.id as ticket_id,t.display_id,c.jurisdiction
    from ticket_messages m join tickets t on t.id=m.ticket_id and t.workspace_id=m.workspace_id
    join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
    where m.workspace_id=${workspaceId} and m.id=any(${examples.map(e=>e.replyId)}::uuid[])
      and m.deleted_at is null and m.merged_from_id is null and m.role='agent'
      and t.deleted_at is null and t.merged_into_id is null and t.status_key in ('resolved','closed')
      and c.deleted_at is null and c.erased_at is null
      and c.brand is not distinct from ${target.brand} and c.jurisdiction is not distinct from ${target.jurisdiction}`;
  return examples.flatMap(example=>{
    const row=rows.find(r=>r.id===example.replyId && r.display_id===example.id);
    return row?[{id:example.id,title:example.title,kind:'ticket' as const,entityId:row.ticket_id,
      datedAt:new Date(row.created_at).toISOString(),...(row.jurisdiction?{market:String(row.jurisdiction).slice(0,100)}:{}),
      warnings:['Previous replies are wording examples, not current policy.']}]:[];
  });
}
