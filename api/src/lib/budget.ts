import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Thrown when a workspace's AI budget is exhausted. Carries the current
 * balance (in micro-USD, can be negative if the workspace overspent before
 * the pre-check) so the API can report a useful 402 to the client.
 */
export class BudgetExceededError extends Error {
  constructor(public balanceMicro: number, public workspaceId: string) {
    super(
      `Workspace ${workspaceId} AI budget exhausted (balance: ${balanceMicro} micro-USD)`,
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * Pre-flight check: refuse the AI call if the workspace has no remaining
 * credit. We allow any positive balance through, even if the call could
 * theoretically overspend — triage calls are bounded at ~$0.05 each, so the
 * worst case is one over-budget call followed by hard refusal on the next.
 *
 * Returns the current balance for the caller to surface in responses.
 *
 * Race window: between this read and `deductBudget` below, another call can
 * land. Two concurrent calls against a workspace with $0.01 can both pass
 * here and both proceed, leaving the workspace ~$0.09 negative. Acceptable
 * at v1 traffic; a proper reservation ledger is the v2 fix.
 */
export async function assertHasBudget(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const { data, error } = await sb
    .from('workspaces')
    .select('ai_credits_micro')
    .eq('id', workspaceId)
    .single();
  if (error) throw new Error(`Budget pre-check failed: ${error.message}`);
  if (!data) throw new Error(`Workspace ${workspaceId} not found`);
  if (data.ai_credits_micro <= 0) {
    throw new BudgetExceededError(data.ai_credits_micro, workspaceId);
  }
  return data.ai_credits_micro;
}

/**
 * Atomically subtract `costMicro` from the workspace's AI credit balance.
 * Returns the new balance. Uses the `deduct_ai_credits` SQL function to
 * keep it to a single UPDATE statement (no read-modify-write race).
 *
 * Best-effort: if this fails after a successful AI call, we log and
 * continue — the call already happened and we already logged its cost in
 * ai_usage_log, so accounting can reconcile from there.
 */
export async function deductBudget(
  sb: SupabaseClient,
  workspaceId: string,
  costMicro: number,
): Promise<number | null> {
  if (costMicro <= 0) return null;
  const { data, error } = await sb.rpc('deduct_ai_credits', {
    p_workspace_id: workspaceId,
    p_amount_micro: costMicro,
  });
  if (error) {
    console.error('deduct_ai_credits failed:', error.message, {
      workspaceId,
      costMicro,
    });
    return null;
  }
  return data as number;
}
