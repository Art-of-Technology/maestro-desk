import { HTTPException } from 'hono/http-exception';
import type { Sql, TransactionSql } from 'postgres';

export const statusCategories = ['open', 'pending', 'escalated', 'gdpr', 'resolved', 'closed'] as const;
export type StatusReason = { key: string; label: string; is_active: boolean };
export const closureReasons: StatusReason[] = ['spam', 'abuse', 'duplicate', 'other'].map(key => ({ key, label: key[0].toUpperCase() + key.slice(1), is_active: true }));
export function validateStatusReason(choice: { reason_required: boolean; reasons: StatusReason[] }, key?: string | null) {
  if (!key) {
    if (choice.reason_required) throw new HTTPException(400, { message: 'Choose a reason for this status.' });
    return null;
  }
  const reason = choice.reasons.find(r => r.key === key && r.is_active);
  if (!reason) throw new HTTPException(400, { message: 'This reason is unavailable. Reload the status options.' });
  return reason;
}
export async function activeTicketStatus(sql: Sql | TransactionSql, workspaceId: string, key: string) {
  const [choice] = await sql<{ key: string; base_key: string; label: string; send_survey: boolean; reason_required: boolean; reasons: StatusReason[] }[]>`
    select key, base_key, label, send_survey, reason_required, reasons from ticket_statuses
    where workspace_id = ${workspaceId} and key = ${key} and is_active = true for share`;
  if (!choice) throw new HTTPException(400, { message: 'This ticket status is unavailable. Reload the status options.' });
  return choice;
}
