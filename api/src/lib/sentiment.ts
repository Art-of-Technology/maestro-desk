// Per-message sentiment classification via Claude Haiku.
//
// Cheap (~$0.0001 / message), fire-and-forget. Called from the
// inbound paths after the message row is inserted; on failure we log
// and leave sentiment=null (the UI handles that as "unknown" — no
// indicator). Budget-gated through the existing workspace AI credits
// system, so workspaces that disabled AI still get message
// persistence without an extra error path.

import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anthropic, computeCostMicro } from './anthropic.ts';
import { assertHasBudget, BudgetExceededError, deductBudget } from './budget.ts';

const MODEL = 'claude-haiku-4-5';

export type Sentiment = 'angry' | 'frustrated' | 'neutral' | 'positive';

const RECORD_SENTIMENT_TOOL: Anthropic.Tool = {
  name: 'record_sentiment',
  description: 'Record the sentiment of the customer message.',
  input_schema: {
    type: 'object',
    properties: {
      sentiment: {
        type: 'string',
        enum: ['angry', 'frustrated', 'neutral', 'positive'],
        description:
          "The customer's emotional state in this message. " +
          "angry = explicit hostility, threats, profanity directed at us; " +
          "frustrated = repeated friction or dissatisfaction without hostility; " +
          "neutral = informational, questions, status checks; " +
          "positive = thanks, compliments, resolution acknowledgements.",
      },
    },
    required: ['sentiment'],
    additionalProperties: false,
  },
};

const SYSTEM = `You classify the sentiment of a single customer message to a support team.
Pick exactly one of: angry, frustrated, neutral, positive.
Be conservative — only mark 'angry' when there's explicit hostility.
Call the record_sentiment tool with your choice.`;

/**
 * Classify one message. Returns the bucket on success, null on
 * failure (budget exceeded, API error, malformed tool call). Updates
 * ticket_messages.sentiment in place so callers don't have to.
 */
export async function scoreMessageSentiment(args: {
  sb:          SupabaseClient;
  workspaceId: string;
  ticketId:    string;
  messageId:   string;
  body:        string;
}): Promise<Sentiment | null> {
  const { sb, workspaceId, ticketId, messageId, body } = args;
  if (!body.trim()) return null;

  // Budget gate. Sentiment is nice-to-have, not load-bearing — if the
  // workspace is out of credits we silently skip rather than letting
  // a BudgetExceededError bubble back into the inbound pipeline.
  try {
    await assertHasBudget(sb, workspaceId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await sb.from('ai_usage_log').insert({
        workspace_id: workspaceId,
        ticket_id: ticketId,
        user_id: null,
        action: 'sentiment_blocked_no_budget',
        model: MODEL,
        input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
        cost_usd_micro: 0, duration_ms: 0, request_id: null,
      });
      return null;
    }
    throw err;
  }

  // Truncate aggressively — sentiment is a coarse signal and we don't
  // need to feed the whole email body. 2k characters is plenty.
  const truncated = body.length > 2000 ? body.slice(0, 2000) + '\n…[truncated]' : body;

  const startedAt = Date.now();
  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [RECORD_SENTIMENT_TOOL],
      tool_choice: { type: 'tool', name: 'record_sentiment' },
      system: SYSTEM,
      messages: [{ role: 'user', content: truncated }],
    });
  } catch (err) {
    console.warn('[sentiment] Anthropic call failed:', err instanceof Error ? err.message : err);
    return null;
  }
  const durationMs = Date.now() - startedAt;
  const costMicro = computeCostMicro(MODEL, {
    input_tokens: response.usage.input_tokens,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    output_tokens: response.usage.output_tokens,
  });

  // Find the tool-use block.
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_sentiment',
  );
  const sentiment = toolUse?.input && typeof (toolUse.input as any).sentiment === 'string'
    ? ((toolUse.input as any).sentiment as Sentiment)
    : null;

  // Always log usage + deduct budget, even on the rare "no tool call"
  // path — tokens were spent.
  await Promise.all([
    sb.from('ai_usage_log').insert({
      workspace_id: workspaceId,
      ticket_id: ticketId,
      user_id: null,
      action: sentiment ? 'sentiment_scored' : 'sentiment_failed_no_tool_use',
      model: MODEL,
      input_tokens: response.usage.input_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      output_tokens: response.usage.output_tokens,
      cost_usd_micro: costMicro,
      duration_ms: durationMs,
      request_id: response.id,
    }),
    deductBudget(sb, workspaceId, costMicro),
  ]);

  if (!sentiment) return null;

  await sb
    .from('ticket_messages')
    .update({ sentiment })
    .eq('id', messageId)
    .eq('workspace_id', workspaceId);

  return sentiment;
}
