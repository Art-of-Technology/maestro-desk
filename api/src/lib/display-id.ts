import type postgres from 'postgres';

// Per-workspace, collision-free display ids (TK-<n> tickets, M<n> customers).
// Replaces the old `TK-<random>` / `M<random>` generators, which failed the
// unique (workspace_id, display_id) constraint on collision with no retry.
//
// The number is allocated by alloc_display_id() (see migration
// 20260619140000) — an atomic per-(workspace, kind) counter. Pass the caller's
// transaction handle when there is one, so the allocation rolls back with the
// insert (no wasted numbers) and shares its lock ordering.

export type DisplayIdKind = 'ticket' | 'customer' | 'channel';

const PREFIX: Record<DisplayIdKind, string> = { ticket: 'TK-', customer: 'M', channel: 'CH-' };

export async function nextDisplayId(
  sql: postgres.Sql<{}> | postgres.TransactionSql<{}>,
  workspaceId: string,
  kind: DisplayIdKind,
): Promise<string> {
  const [row] = await sql<{ n: string | null }[]>`
    select alloc_display_id(${workspaceId}, ${kind}) as n
  `;
  // alloc_display_id always returns a non-null bigint on success (it throws a
  // 23503 FK violation if the workspace no longer exists). Guard anyway so a
  // surprising null/empty result fails loudly rather than minting "TK-undefined".
  if (row?.n == null) {
    throw new Error(`Failed to allocate ${kind} display id for workspace ${workspaceId}`);
  }
  // Channels pad to 3 digits (CH-004) to match the seeded CH-001 style —
  // the channels list orders by display_id as text. Tickets/customers keep
  // their unpadded legacy format.
  const n = kind === 'channel' ? String(row.n).padStart(3, '0') : row.n;
  return `${PREFIX[kind]}${n}`;
}
