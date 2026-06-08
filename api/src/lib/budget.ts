import { getDb } from './db.ts';

// Migration to Neon — Step 3 (tickets megabatch). Reads/writes via getDb().
// The first `_sb` param is retained (accepted-but-ignored) so callers don't
// change while the subsystem migrates; it'll be dropped in a cleanup pass.

/**
 * Thrown when a workspace's AI budget is exhausted. Carries the current
 * balance (micro-USD, can be negative) so the API can report a useful 402.
 */
export class BudgetExceededError extends Error {
  constructor(public balanceMicro: number, public workspaceId: string) {
    super(`Workspace ${workspaceId} AI budget exhausted (balance: ${balanceMicro} micro-USD)`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Pre-flight check: refuse the AI call if the workspace has no remaining
 * credit. Returns the current balance. (ai_credits_micro is bigint — comes
 * back from postgres.js as a string, so it's coerced with Number().)
 */
export async function assertHasBudget(_sb: unknown, workspaceId: string): Promise<number> {
  const sql = getDb();
  const [row] = await sql<{ ai_credits_micro: string }[]>`
    select ai_credits_micro from workspaces where id = ${workspaceId}
  `;
  if (!row) throw new Error(`Workspace ${workspaceId} not found`);
  const balance = Number(row.ai_credits_micro);
  if (balance <= 0) throw new BudgetExceededError(balance, workspaceId);
  return balance;
}

/**
 * Atomically subtract `costMicro` from the workspace's AI credit balance via
 * the deduct_ai_credits SQL function (single UPDATE, no read-modify-write
 * race). Returns the new balance, or null on failure (best-effort — the AI
 * call already happened and its cost is in ai_usage_log).
 */
export async function deductBudget(_sb: unknown, workspaceId: string, costMicro: number): Promise<number | null> {
  if (costMicro <= 0) return null;
  try {
    const sql = getDb();
    const [row] = await sql<{ balance: string }[]>`
      select public.deduct_ai_credits(${workspaceId}, ${costMicro}) as balance
    `;
    return row ? Number(row.balance) : null;
  } catch (err) {
    console.error('deduct_ai_credits failed:', err instanceof Error ? err.message : err, { workspaceId, costMicro });
    return null;
  }
}
