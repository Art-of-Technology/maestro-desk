import type postgres from 'postgres';

// Per-workspace, collision-free display ids (TK-<n> tickets, M<n> customers).
// Replaces the old `TK-<random>` / `M<random>` generators, which failed the
// unique (workspace_id, display_id) constraint on collision with no retry.
//
// The number is allocated by alloc_display_id() (see migration
// 20260619140000) — an atomic per-(workspace, kind) counter. Pass the caller's
// transaction handle when there is one, so the allocation rolls back with the
// insert (no wasted numbers) and shares its lock ordering.

export type DisplayIdKind = 'ticket' | 'customer';

const PREFIX: Record<DisplayIdKind, string> = { ticket: 'TK-', customer: 'M' };

export async function nextDisplayId(
  sql: postgres.Sql<{}> | postgres.TransactionSql<{}>,
  workspaceId: string,
  kind: DisplayIdKind,
): Promise<string> {
  const [row] = await sql<{ n: string }[]>`
    select alloc_display_id(${workspaceId}, ${kind}) as n
  `;
  return `${PREFIX[kind]}${row.n}`;
}
