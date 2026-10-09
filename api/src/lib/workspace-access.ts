import { HTTPException } from 'hono/http-exception';
import { getDb } from './db.js';
import { lockTicketPrivacy, type TicketPrivacy } from './ticket-privacy.js';

// Identity and platform recovery use requireAuthOnly. Normal workspace work
// must pass this check, including work that did not start in an HTTP request.
export async function workspaceAvailable(workspaceId: string, generation?: string): Promise<boolean> {
  const [row] = await getDb()`select 1 from workspaces where id=${workspaceId}
    and deleted_at is null and suspended_at is null
    and (${generation ?? null}::bigint is null or suspension_generation=${generation ?? null}::bigint)`;
  return Boolean(row);
}

export async function requireAvailableWorkspace(workspaceId: string, generation?: string): Promise<void> {
  if (!await workspaceAvailable(workspaceId, generation)) {
    throw new HTTPException(403, { message: 'This workspace is unavailable.' });
  }
}

export async function workspaceAccessGeneration(workspaceId: string): Promise<string> {
  const [row] = await getDb()`select suspension_generation::text as generation from workspaces
    where id=${workspaceId} and deleted_at is null and suspended_at is null`;
  if (!row) throw new HTTPException(403, { message: 'This workspace is unavailable.' });
  return row.generation;
}

// Hold only around a bounded external send, never around code that needs
// another database connection. Suspension waits for a started send to finish.
export async function sendWhileWorkspaceAvailable<T>(workspaceId: string, send: () => Promise<T>, generation?: string, privacy: TicketPrivacy = []): Promise<T> {
  return getDb().begin(async tx => {
    const [row] = await tx`select id from workspaces where id=${workspaceId} and deleted_at is null and suspended_at is null
      and not is_unrouted_bucket
      and (${generation ?? null}::bigint is null or suspension_generation=${generation ?? null}::bigint) for share`;
    if (!row) throw new HTTPException(403, { message: 'This workspace is unavailable.' });
    await lockTicketPrivacy(tx, workspaceId, privacy);
    return send();
  }) as Promise<T>;
}
