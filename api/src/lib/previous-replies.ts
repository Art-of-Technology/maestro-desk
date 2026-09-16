import { getDb } from './db.js';

const STOP = new Set('the and for that this with have from your you can please help hello thanks thank would could about ticket reply customer'.split(' '));
export function replyTerms(text: string) {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,40}/gu) || []).filter(t => !STOP.has(t)))].slice(0, 30);
}

export function rankReplies<T extends { subject: string; question: string }>(query: string, rows: T[]) {
  const terms = replyTerms(query);
  if (terms.length < 2) return [];
  return rows.map(row => {
    const words = new Set(replyTerms(`${row.subject} ${row.question}`));
    return { ...row, score: terms.filter(t => words.has(t)).length };
  }).filter(row => row.score >= Math.max(2, Math.ceil(terms.length * 0.3)))
    .sort((a, b) => b.score - a.score).slice(0, 3);
}

export function genericDetails(text: string, customer: Record<string, unknown>, ticket: string) {
  const replacements: [unknown, string][] = [
    [ticket, '{ticket}'],
    [[customer.first_name, customer.last_name].filter(Boolean).join(' '), '{name}'],
    [customer.first_name, '{name}'], [customer.last_name, '{name}'],
    [customer.email, '{email}'], [customer.mobile, '{phone}'], [customer.username, '{username}'],
  ];
  const known = new Map(replacements.filter(([value]) => typeof value === 'string' && value.trim())
    .map(([value, placeholder]) => [String(value).toLowerCase(), placeholder]));
  const alternatives = [...known.keys()].sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (alternatives) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_{])(?:${alternatives})(?![\\p{L}\\p{N}_}])`, 'giu'), value => known.get(value.toLowerCase())!);
  return text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '{email}')
    .replace(/https?:\/\/\S+/gi, '{link}')
    .replace(/\b\d[\d ()+-]{6,}\d\b/g, '{reference}');
}

export async function previousReplyMaterial(workspaceId: string, ticketId: string, includeExamples = true) {
  const sql = getDb();
  const [ticket] = await sql`
    select t.id,t.display_id,t.subject,c.brand,c.jurisdiction,
      c.first_name,c.last_name,c.email,c.mobile,c.username
    from tickets t join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
    where t.workspace_id=${workspaceId} and t.id=${ticketId} and t.deleted_at is null
      and t.merged_into_id is null and c.deleted_at is null and c.erased_at is null`;
  if (!ticket) return null;
  if (!includeExamples) return { ticket, query: '', messages: [], examples: [] };
  const messages = await sql`
    select role,left(body,4000) as body from ticket_messages
    where workspace_id=${workspaceId} and ticket_id=${ticketId} and deleted_at is null
      and role in ('customer','agent') order by created_at desc,id desc limit 12`;
  const query = `${ticket.subject} ${messages.find(m => m.role === 'customer')?.body || ''}`;
  // Bounded recent history avoids an unindexed full-message scan. Workspace is
  // the authorization boundary; legacy customer brands/markets narrow it further.
  const rows = await sql<{ display_id: string; subject: string; question: string; reply: string;
    first_name: string; last_name: string; email: string | null; mobile: string | null; username: string | null }[]>`
    with candidates as (
      select t.id,t.display_id,t.subject,t.updated_at,c.first_name,c.last_name,c.email,c.mobile,c.username
      from tickets t join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
      where t.workspace_id=${workspaceId} and t.id<>${ticketId} and t.deleted_at is null
        and t.merged_into_id is null and t.status_key in ('resolved','closed') and c.deleted_at is null and c.erased_at is null
        and c.brand is not distinct from ${ticket.brand}
        and c.jurisdiction is not distinct from ${ticket.jurisdiction}
      order by t.updated_at desc,t.id limit 200
    )
    select t.*,q.body as question,r.body as reply from candidates t
    join lateral (select left(body,4000) as body,created_at from ticket_messages
      where workspace_id=${workspaceId} and ticket_id=t.id and role='agent'
        and deleted_at is null and merged_from_id is null
      order by created_at desc,id desc limit 1) r on true
    join lateral (select left(body,2000) as body from ticket_messages
      where workspace_id=${workspaceId} and ticket_id=t.id and role='customer'
        and deleted_at is null and merged_from_id is null and created_at<=r.created_at
      order by created_at desc,id desc limit 1) q on true
    order by t.updated_at desc,t.id`;
  const examples = rankReplies(query, rows).map(r => ({
    id: r.display_id, title: genericDetails(r.subject, r, r.display_id).slice(0, 300),
    question: genericDetails(r.question, r, r.display_id),
    reply: genericDetails(r.reply, r, r.display_id),
  }));
  return { ticket, query, messages: messages.reverse(), examples };
}
