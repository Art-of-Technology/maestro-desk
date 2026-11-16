import { createHash } from 'node:crypto';
import type postgres from 'postgres';

type Db = postgres.Sql<{}> | postgres.TransactionSql<{}>;
export const normalizeName = (value: unknown) => String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

export async function customerEmailNames(sql: Db, workspaceId: string, customerId: string) {
  const [customer] = await sql`select id, first_name, last_name, maestro_user_id, email
    from customers where id = ${customerId} and workspace_id = ${workspaceId}
      and deleted_at is null and erased_at is null and merged_into_customer_id is null`;
  if (!customer) return null;
  const first = normalizeName(customer.first_name), last = normalizeName(customer.last_name);
  const accountName = customer.maestro_user_id ? [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() : '';
  const senders = await sql`with addresses as (
      select lower(trim(value::text)) as email from customer_contacts
      where workspace_id = ${workspaceId} and customer_id = ${customerId} and kind = 'email' and deleted_at is null
      union select lower(trim(${customer.email || ''}::text))
    )
    select a.email, m.author_label
    from addresses a left join lateral (
      select m.author_label from ticket_messages m
      join tickets t on t.id = m.ticket_id and t.workspace_id = m.workspace_id
      where m.workspace_id = ${workspaceId} and t.customer_id = ${customerId} and t.deleted_at is null
        and m.deleted_at is null and m.role = 'customer' and m.merged_from_id is null
        and cardinality(m.forwarded_from_ticket_ids) = 0
        and m.email_metadata->>'status' = 'received'
        and lower(trim(m.email_metadata->>'from')) = a.email
      order by m.created_at desc, m.id desc limit 1
    ) m on true where a.email <> '' order by a.email`;
  const entries = senders.map(row => {
    const sender = normalizeName(row.author_label);
    const senderName = sender && sender !== row.email ? String(row.author_label).trim() : null;
    const mismatch = Boolean(customer.maestro_user_id && first && last && senderName && sender !== first + ' ' + last);
    const key = mismatch ? createHash('sha256').update(JSON.stringify([
      customerId, customer.maestro_user_id, row.email, sender, first, last,
    ])).digest('hex') : null;
    return { email: String(row.email), sender_name: senderName, mismatch, review_key: key,
      reviewed: null as null | { by: string; at: string; reason: string } };
  });
  const keys = entries.flatMap(e => e.review_key ? [e.review_key] : []);
  if (keys.length) {
    const reviews = await sql`select distinct on (n.name_review_key) n.name_review_key, n.text, n.created_at, u.name
      from customer_notes n left join users u on u.id = n.author_user_id
      where n.workspace_id = ${workspaceId} and n.customer_id = ${customerId}
        and n.deleted_at is null and n.name_review_key in ${sql(keys)}
      order by n.name_review_key, n.created_at desc, n.id desc`;
    for (const entry of entries) {
      const review = reviews.find(n => n.name_review_key === entry.review_key);
      if (review) entry.reviewed = { by: String(review.name || 'Agent'), at: new Date(review.created_at).toISOString(), reason: String(review.text) };
    }
  }
  return { account_holder_name: accountName || null, entries };
}
