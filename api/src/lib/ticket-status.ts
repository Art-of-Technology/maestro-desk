import { HTTPException } from 'hono/http-exception';
import type { Sql, TransactionSql } from 'postgres';

export const statusCategories = ['open', 'pending', 'escalated', 'gdpr', 'resolved', 'closed'] as const;
export async function activeTicketStatus(sql: Sql | TransactionSql, workspaceId: string, key: string) {
  const [choice] = await sql<{ key: string; base_key: string; label: string; send_survey: boolean }[]>`
    select key, base_key, label, send_survey from ticket_statuses
    where workspace_id = ${workspaceId} and key = ${key} and is_active = true for share`;
  if (!choice) throw new HTTPException(400, { message: 'This ticket status is unavailable. Reload the status options.' });
  return choice;
}
