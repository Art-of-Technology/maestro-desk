import { createHash } from 'node:crypto';

export type QualityArticle = {id:string;title:string;category:string;body:string;status:string;review_due_date?:string|null; duplicates?:string[]};
export type QualityFinding = {kind:string;detail:string};
export function qualityFingerprint(a: QualityArticle) {
  return createHash('sha256').update(JSON.stringify([a.title,a.category,a.body,a.status,a.review_due_date || null])).digest('hex');
}
export function articleLinks(body: string): string[] {
  return [...new Set(body.match(/https?:\/\/[^\s<>"\]\)]+/gi) || [])].filter(value => {
    try { const url=new URL(value);return !url.username && !url.password; } catch {return false;}
  });
}
export function qualitySignals(a: QualityArticle, today = new Date().toISOString().slice(0,10)): QualityFinding[] {
  if (a.status === 'archived') return [];
  const issues: QualityFinding[]=[];
  const content=a.body.split(/\r?\n/).filter(line=>!/^(?:Source URL|Requested URL|Language \/ market|Retrieved|Redirected URL):/i.test(line.trim())).join(' ');
  const words=content.replace(/https?:\/\/\S+/g,'').replace(/[#*>`\[\]()]/g,' ').trim().split(/\s+/).filter(Boolean).length;
  const linkOnly=/^https?:\/\/\S+$/.test(a.body.trim());
  if(words<40 && !linkOnly) issues.push({kind:'thin',detail:`Only ${words} words after removing import metadata and URLs. Check whether this is enough to answer a customer question.`});
  if(a.duplicates?.length) issues.push({kind:'duplicate',detail:`Identical body in the same category and market: ${a.duplicates.join(', ')}. Compare before making changes.`});
  const expiryDates=[...content.matchAll(/(?:expires?|ends?|valid until|offer until|vence|finaliza|v[aá]lido hasta)\s*:?\s*(\d{4}-\d{2}-\d{2})/gi)].map(m=>m[1]);
  const expired=expiryDates.find(date=>/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(date) && date<today);
  if(expired && /promo|bonus|offer|oferta|bono/i.test(a.title+' '+content)) issues.push({kind:'promotion',detail:`Promotion text contains a past expiry date (${expired}). Confirm the terms before updating or archiving it.`});
  if(a.review_due_date && a.review_due_date<today) issues.push({kind:'overdue',detail:`Review was due ${a.review_due_date}. Check the article and set its next review date.`});
  const links=articleLinks(a.body);
  if(links.length) issues.push({kind:'links',detail:`${links.length} link${links.length===1?'':'s'} available to check. Link checks run only when requested.`});
  return issues;
}
