import { HTTPException } from 'hono/http-exception';
import type { TransactionSql } from 'postgres';
import { getDb } from './db.js';

export type TicketPrivacy = Array<{ id: string; generation: string }>;

// Capture BEFORE reading personal content. Erasure invalidates affected copies too.
export async function ticketPrivacy(workspaceId: string, ticketIds: string[]): Promise<TicketPrivacy> {
  const ids = [...new Set(ticketIds)];
  if (!ids.length) return [];
  const rows = await getDb()<TicketPrivacy>`select t.id,t.privacy_generation::text as generation
    from tickets t join customers c on c.id=t.customer_id and c.workspace_id=t.workspace_id
    where t.workspace_id=${workspaceId} and t.id=any(${ids}::uuid[])
      and t.deleted_at is null and t.merged_into_id is null and c.erased_at is null and c.deleted_at is null`;
  if (rows.length !== ids.length) throw new HTTPException(404, { message: 'Ticket not found.' });
  return [...rows];
}

// Result-pattern senders skip unavailable tickets; unexpected failures still surface.
export async function availableTicketPrivacy(workspaceId: string, ticketIds: string[]): Promise<TicketPrivacy | null> {
  try { return await ticketPrivacy(workspaceId, ticketIds); }
  catch (err) {
    if (err instanceof HTTPException && err.status === 404) return null;
    throw err;
  }
}

// NOWAIT makes a concurrent privacy/ownership change a retry, rather than a
// customer -> ticket / ticket -> customer deadlock. Never hold across an AI call.
export async function lockTicketPrivacy(tx: TransactionSql, workspaceId: string, snapshot: TicketPrivacy): Promise<void> {
  if (!snapshot.length) return;
  await tx`select assert_ticket_content(${workspaceId}::uuid,${snapshot.map(t => t.id)}::uuid[])`;
  const rows = await tx`select id,privacy_generation::text as generation from tickets
    where workspace_id=${workspaceId} and id=any(${snapshot.map(t => t.id)}::uuid[])
      and deleted_at is null and merged_into_id is null order by id`;
  if (rows.length !== snapshot.length || snapshot.some(t => !rows.some(r => r.id===t.id && r.generation===t.generation))) {
    throw new HTTPException(409, { message: 'Ticket privacy or ownership changed. Reload it before trying again.' });
  }
}

export async function requireTicketPrivacy(workspaceId: string, snapshot: TicketPrivacy): Promise<void> {
  if (!snapshot.length) return;
  await getDb().begin(tx => lockTicketPrivacy(tx, workspaceId, snapshot));
}
