import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, computeCostMicro } from './anthropic.js';
import { getDb } from './db.js';

const MODEL = 'claude-haiku-4-5';
// At most two calls per lookup, each reserving <= $0.05, without retries.
export const SEARCH_CALL_CAP_MICRO = 50_000;
export const SEARCH_TIMEOUT_MS = 8000;

export async function replySearchTool(workspaceId: string, userId: string,
  action: 'reply_search_expand' | 'reply_search_rank', system: string, content: string, tool: Anthropic.Tool) {
  const sql = getDb();
  const reserved = computeCostMicro(MODEL, {
    input_tokens: Buffer.byteLength(system + content + JSON.stringify(tool)) + 1024,
    output_tokens: 512, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  });
  if (reserved > SEARCH_CALL_CAP_MICRO) return { input: null, costMicro: 0 };
  const [reservation] = await sql`update workspaces set ai_credits_micro=ai_credits_micro-${reserved}
    where id=${workspaceId} and ai_credits_micro>=${reserved} returning id`;
  if (!reservation) return { input: null, costMicro: 0 };
  const started = Date.now();
  let response;
  try {
    response = await anthropic.messages.create({ model: MODEL, max_tokens: 512, system,
      messages: [{ role: 'user', content }], tools: [tool], tool_choice: { type: 'tool', name: tool.name } },
    { timeout: SEARCH_TIMEOUT_MS, maxRetries: 0 });
  } catch {
    await sql`update workspaces set ai_credits_micro=ai_credits_micro+${reserved} where id=${workspaceId}`;
    return { input: null, costMicro: 0 };
  }
  const usage = {
    input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: response.usage.cache_read_input_tokens || 0,
  };
  const costMicro = computeCostMicro(MODEL, usage);
  // Database/settlement failures propagate: never pretend a paid call was free.
  await sql.begin(async tx => {
    await tx`update workspaces set ai_credits_micro=ai_credits_micro+${reserved - costMicro} where id=${workspaceId}`;
    await tx`insert into ai_usage_log(workspace_id,user_id,action,model,input_tokens,output_tokens,
      cache_creation_input_tokens,cache_read_input_tokens,cost_usd_micro,duration_ms,request_id)
      values (${workspaceId},${userId},${action},${MODEL},${usage.input_tokens},${usage.output_tokens},
        ${usage.cache_creation_input_tokens},${usage.cache_read_input_tokens},${costMicro},${Date.now() - started},${response.id})`;
  });
  const result = response.content.find(b => b.type === 'tool_use' && b.name === tool.name);
  return { input: response.stop_reason !== 'max_tokens' && result?.type === 'tool_use' ? result.input : null, costMicro };
}
