import type postgres from 'postgres';
import { resolveCustomerByContact } from './customer-contacts.js';

// Resolve the actual sender, including secondary addresses, in the destination workspace.
// Hold the customer lock until the reply is saved, serializing with mark/unmark.
export async function spamSender(sql: postgres.TransactionSql, workspaceId: string, email: string): Promise<string | null> {
  const sender = await resolveCustomerByContact(sql, workspaceId, 'email', email);
  if (!sender) return null;
  const id = sender.merged_into_customer_id || sender.id;
  const [customer] = await sql`select id, is_spam from customers where id = ${id} and workspace_id = ${workspaceId}
    and deleted_at is null and erased_at is null for update`;
  return customer?.is_spam ? customer.id : null;
}

export async function setCustomerSpam(sql: postgres.TransactionSql, workspaceId: string, customerId: string, spam: boolean, actorId: string) {
  const [changed] = await sql`update customers set is_spam = ${spam}
    where id = ${customerId} and workspace_id = ${workspaceId} and deleted_at is null
      and erased_at is null and merged_into_customer_id is null and is_spam <> ${spam}
    returning id`;
  if (changed) await sql`insert into audit_events (workspace_id, actor_user_id, action, target_type, target_id, metadata)
    values (${workspaceId}, ${actorId}, ${spam ? 'customer.spam_marked' : 'customer.spam_unmarked'}, 'customer', ${customerId}, '{}')`;
}
