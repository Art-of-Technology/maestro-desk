import { getDb } from './db.js';

export type ReplyTicket = { id: string; display_id: string; subject: string; brand: string | null;
  jurisdiction: string | null; first_name: string; last_name: string; email: string | null;
  mobile: string | null; username: string | null };

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
  const [ticket] = await sql<ReplyTicket[]>`
    select t.id,t.display_id,t.subject,c.brand,c.jurisdiction,
      c.first_name,c.last_name,c.email,c.mobile,c.username
    from tickets t join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
    where t.workspace_id=${workspaceId} and t.id=${ticketId} and t.deleted_at is null
      and t.merged_into_id is null and c.deleted_at is null and c.erased_at is null`;
  if (!ticket) return null;
  const messages = await sql`
    select role,left(body,4000) as body from ticket_messages
    where workspace_id=${workspaceId} and ticket_id=${ticketId} and deleted_at is null
      and role in ('customer','agent') order by created_at desc,id desc limit 12`;
  const query = `${ticket.subject} ${messages.find(m => m.role === 'customer')?.body || ''}`;
  const candidates = includeExamples ? await searchReplyHistory(workspaceId, ticket, query) : [];
  const examples = keywordExamples(query, candidates);
  return { ticket, query, messages: messages.reverse(), examples };
}

export type ReplyExample = { id: string; title: string; question: string; reply: string;
  questionId: string; replyId: string };
type ReplyRow = { display_id: string; subject: string; question: string; reply: string;
  question_id: string; reply_id: string; first_name: string; last_name: string;
  email: string | null; mobile: string | null; username: string | null };
function redactExample(r: ReplyRow): ReplyExample {
  return { id: r.display_id, title: genericDetails(r.subject, r, r.display_id).slice(0, 300),
    question: genericDetails(r.question, r, r.display_id), reply: genericDetails(r.reply, r, r.display_id),
    questionId: r.question_id, replyId: r.reply_id };
}
export function keywordExamples(query: string, examples: ReplyExample[]) {
  return rankReplies(query, examples.map(e => ({ ...e, subject: e.title })))
    .filter((e, i, all) => all.findIndex(r => r.id === e.id) === i).map(({ subject, score, ...e }) => e);
}

export async function searchReplyHistory(workspaceId: string, ticket: ReplyTicket, query: string) {
  const terms = replyTerms(query).join(' | ');
  if (!terms) return [];
  const sql = getDb();
  // Search before limiting: older relevant replies compete with recent ones.
  // Separate UNION branches allow PostgreSQL to use each GIN index.
  return sql.begin(async tx => {
    await tx`set local statement_timeout = '4s'`;
    const rows = await tx<ReplyRow[]>`
      with eligible as not materialized (
        select t.*,c.first_name,c.last_name,c.email,c.mobile,c.username
        from tickets t join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
        where t.workspace_id=${workspaceId} and t.id<>${ticket.id} and t.deleted_at is null
          and t.merged_into_id is null and t.status_key in ('resolved','closed')
          and c.deleted_at is null and c.erased_at is null
          and c.brand is not distinct from ${ticket.brand}
          and c.jurisdiction is not distinct from ${ticket.jurisdiction}
      ), hits as (
        (select q.id,q.ticket_id,q.created_at,ts_rank(to_tsvector('simple',left(q.body,8000)),to_tsquery('simple',${terms})) as score
          from ticket_messages q join eligible t on t.id=q.ticket_id
          where q.workspace_id=${workspaceId} and q.role='customer' and q.deleted_at is null and q.merged_from_id is null
            and to_tsvector('simple',left(q.body,8000)) @@ to_tsquery('simple',${terms})
          order by score desc,q.created_at desc,q.id limit 40)
        union all
        (select q.id,t.id,q.created_at,ts_rank(to_tsvector('simple',left(t.subject,1000)),to_tsquery('simple',${terms})) as score
          from eligible t join lateral (
            select id,created_at from ticket_messages where workspace_id=${workspaceId} and ticket_id=t.id
              and role='customer' and deleted_at is null and merged_from_id is null
            order by created_at desc,id desc limit 1) q on true
          where to_tsvector('simple',left(t.subject,1000)) @@ to_tsquery('simple',${terms})
          order by score desc,q.created_at desc,q.id limit 40)
      ), distinct_hits as (
        select id,ticket_id,created_at,max(score) as score from hits group by id,ticket_id,created_at
      )
      select t.display_id,t.subject,t.first_name,t.last_name,t.email,t.mobile,t.username,
        q.id as question_id,r.id as reply_id,left(q.body,2000) as question,r.body as reply
      from distinct_hits h join eligible t on t.id=h.ticket_id
      join ticket_messages q on q.id=h.id and q.workspace_id=${workspaceId}
      join lateral (select id,left(body,4000) as body from ticket_messages
        where workspace_id=${workspaceId} and ticket_id=t.id and role='agent'
          and deleted_at is null and merged_from_id is null and created_at>=q.created_at
        order by created_at,id limit 1) r on true
      order by h.score desc,h.created_at desc,q.id limit 12`;
    return rows.map(redactExample);
  });
}

export async function revalidateReplyExamples(workspaceId: string, ticket: ReplyTicket, examples: ReplyExample[]) {
  if (!examples.length) return [];
  const sql = getDb();
  const rows = await sql<ReplyRow[]>`select t.display_id,t.subject,c.first_name,c.last_name,c.email,c.mobile,c.username,
    q.id as question_id,r.id as reply_id,left(q.body,2000) as question,left(r.body,4000) as reply
    from tickets t join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
    join ticket_messages q on q.ticket_id=t.id and q.workspace_id=t.workspace_id
    join ticket_messages r on r.ticket_id=t.id and r.workspace_id=t.workspace_id
    where t.workspace_id=${workspaceId} and t.id<>${ticket.id} and t.deleted_at is null
      and t.merged_into_id is null and t.status_key in ('resolved','closed')
      and c.deleted_at is null and c.erased_at is null
      and c.brand is not distinct from ${ticket.brand} and c.jurisdiction is not distinct from ${ticket.jurisdiction}
      and q.id in ${sql(examples.map(e => e.questionId))} and r.id in ${sql(examples.map(e => e.replyId))}
      and q.role='customer' and r.role='agent' and q.deleted_at is null and r.deleted_at is null
      and q.merged_from_id is null and r.merged_from_id is null`;
  const fresh = rows.map(redactExample);
  return examples.filter(e => fresh.some(r => JSON.stringify(r) === JSON.stringify(e)));
}
