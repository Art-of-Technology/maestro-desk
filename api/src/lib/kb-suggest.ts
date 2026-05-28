import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anthropic, computeCostMicro } from './anthropic.ts';
import { assertHasBudget, BudgetExceededError, deductBudget } from './budget.ts';

// Haiku is the cost-optimised choice — accurate enough for ranking
// short KB titles against a free-text question, and ~5× cheaper than
// Sonnet. Sticks under $0.001 per portal hit at typical lengths.
const MODEL = 'claude-haiku-4-5';

const SUGGEST_TOOL: Anthropic.Tool = {
  name: 'suggest_kb_articles',
  description:
    "Return up to three KB articles most likely to resolve the customer's question, ranked by confidence (0-100). Omit articles below confidence 40. Set the suggestions array to empty if none of the articles are a good match — the customer will submit a ticket instead.",
  input_schema: {
    type: 'object',
    required: ['suggestions'],
    properties: {
      suggestions: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          required: ['article_id', 'confidence', 'reason'],
          properties: {
            article_id: { type: 'string', description: "The KB article's display id (e.g. 'KB-001')." },
            confidence: { type: 'number', minimum: 0, maximum: 100 },
            reason:     { type: 'string', maxLength: 200, description: 'One sentence explaining why this article helps.' },
          },
        },
      },
    },
  },
};

export interface KbSuggestion {
  article_id:  string;
  confidence:  number;
  reason:      string;
}

export interface KbSuggestResult {
  suggestions: KbSuggestion[];
  cost_micro:  number;
}

/**
 * AI-rank the workspace's published KB articles against a customer
 * question. Deducts from ai_credits_micro; out-of-budget returns
 * empty suggestions so the portal degrades gracefully (customer
 * still submits normally).
 */
export async function suggestKbForQuestion(args: {
  sb:          SupabaseClient;
  workspaceId: string;
  question:    string;
}): Promise<KbSuggestResult> {
  const { sb, workspaceId, question } = args;

  // Pull the workspace's published articles. Body is truncated server-
  // side to keep input tokens bounded — the model just needs the gist.
  const { data: articles, error } = await sb
    .from('kb_articles')
    .select('id, display_id, title, category, body')
    .eq('workspace_id', workspaceId)
    .eq('status', 'published')
    .order('updated_at', { ascending: false });
  if (error || !articles || articles.length === 0) {
    return { suggestions: [], cost_micro: 0 };
  }

  // Budget gate. If the workspace ran out of AI credits we return empty
  // rather than calling the API — the portal then falls back to
  // "submit your question" without the suggestions block.
  try { await assertHasBudget(sb, workspaceId); }
  catch (err) {
    if (err instanceof BudgetExceededError) return { suggestions: [], cost_micro: 0 };
    throw err;
  }

  // System prompt is cacheable so consecutive portal calls from the
  // same workspace hit the prompt cache (5-min TTL). The KB index
  // itself lives in the cached system block — that's the bulk of the
  // input tokens.
  const kbBlock = articles.map((a) =>
    `[${a.display_id}] ${a.category || 'Help'} — ${a.title}\n${(a.body || '').slice(0, 600)}`,
  ).join('\n\n');

  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: `You are a customer-support routing assistant. Given a customer question and a list of KB articles, identify the up-to-three articles that best resolve the question. Be strict: only return suggestions where you're confident (>= 40) the article answers the question. If none do, return an empty list — the customer will submit a ticket.

Always use the suggest_kb_articles tool. Refer to articles by their display id (e.g. "KB-001").`,
    },
    {
      type: 'text',
      cache_control: { type: 'ephemeral' },
      text: `KB articles available:\n\n${kbBlock}`,
    },
  ];

  const started = Date.now();
  const response = await anthropic.messages.create({
    model:       MODEL,
    max_tokens:  600,
    system,
    tools:       [SUGGEST_TOOL],
    tool_choice: { type: 'tool', name: 'suggest_kb_articles' },
    messages: [
      { role: 'user', content: `Customer question:\n\n${question.slice(0, 4000)}` },
    ],
  });
  const elapsedMs = Date.now() - started;

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'suggest_kb_articles',
  );
  const raw = (toolUse?.input as { suggestions?: KbSuggestion[] })?.suggestions ?? [];

  // Build a lookup from display_id → id so we can drop hallucinated ones.
  const validIds = new Set(articles.map((a) => a.display_id));
  const suggestions: KbSuggestion[] = raw
    .filter((s) => validIds.has(s.article_id))
    .filter((s) => Number.isFinite(s.confidence) && s.confidence >= 40)
    .slice(0, 3);

  // Deduct + audit. Use the same usage-log shape as triage so the AI
  // dashboard can group both surfaces under "AI usage by action".
  const costMicro = computeCostMicro(MODEL, {
    input_tokens:                response.usage.input_tokens,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens:     response.usage.cache_read_input_tokens || 0,
    output_tokens:               response.usage.output_tokens,
  });
  try {
    await deductBudget(sb, workspaceId, costMicro);
    await sb.from('ai_usage_log').insert({
      workspace_id:                workspaceId,
      user_id:                     null,
      model:                       MODEL,
      action:                      'kb_suggest',
      input_tokens:                response.usage.input_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens:     response.usage.cache_read_input_tokens || 0,
      output_tokens:               response.usage.output_tokens,
      cost_usd_micro:              costMicro,
      duration_ms:                 elapsedMs,
      request_id:                  response.id,
    });
  } catch (err) {
    console.warn('[kb-suggest] usage log / deduct failed:', err);
  }

  return { suggestions, cost_micro: costMicro };
}
