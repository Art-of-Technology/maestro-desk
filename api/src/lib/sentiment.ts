// Per-message sentiment classification via Claude Haiku.
//
// Cheap (~$0.0001 / message), fire-and-forget. Called from the
// inbound paths after the message row is inserted; on failure we log
// and leave sentiment=null (the UI handles that as "unknown" — no
// indicator). Budget-gated through the existing workspace AI credits
// system, so workspaces that disabled AI still get message
// persistence without an extra error path.

import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, computeCostMicro } from './anthropic.ts';
import { assertHasBudget, BudgetExceededError, deductBudget } from './budget.ts';
import { getDb } from './db.ts';

// Migration to Neon — Step 3 (tickets megabatch). DB via getDb().

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
  workspaceId: string;
  ticketId:    string;
  messageId:   string;
  body:        string;
}): Promise<Sentiment | null> {
  const { workspaceId, ticketId, messageId, body } = args;
  if (!body.trim()) return null;
  const sql = getDb();

  // Budget gate. Sentiment is nice-to-have, not load-bearing — if the
  // workspace is out of credits we silently skip rather than letting
  // a BudgetExceededError bubble back into the inbound pipeline.
  try {
    await assertHasBudget(workspaceId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await sql`
        insert into ai_usage_log (workspace_id, ticket_id, user_id, action, model,
          input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
          cost_usd_micro, duration_ms, request_id)
        values (${workspaceId}, ${ticketId}, null, 'sentiment_blocked_no_budget', ${MODEL},
          0, 0, 0, 0, 0, 0, null)
      `;
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
    sql`
      insert into ai_usage_log (workspace_id, ticket_id, user_id, action, model,
        input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens,
        cost_usd_micro, duration_ms, request_id)
      values (${workspaceId}, ${ticketId}, null,
        ${sentiment ? 'sentiment_scored' : 'sentiment_failed_no_tool_use'}, ${MODEL},
        ${response.usage.input_tokens}, ${response.usage.cache_creation_input_tokens ?? 0},
        ${response.usage.cache_read_input_tokens ?? 0}, ${response.usage.output_tokens},
        ${costMicro}, ${durationMs}, ${response.id})
    `,
    deductBudget(workspaceId, costMicro),
  ]);

  if (!sentiment) return null;

  // Fetch the message timestamp once — used by both the message
  // update and the denormalised tickets stamp. We could read it from
  // the .single() return on insert, but threading that through every
  // caller is more friction than just re-reading.
  const [msgRow] = await sql<{ created_at: string }[]>`
    select created_at from ticket_messages where id = ${messageId} and workspace_id = ${workspaceId}
  `;
  const messageCreatedAt = msgRow?.created_at;

  await sql`
    update ticket_messages set sentiment = ${sentiment}
    where id = ${messageId} and workspace_id = ${workspaceId}
  `;

  // Denormalise onto tickets so the SPA list can filter by sentiment
  // without joining ticket_messages on every render. Only overwrite
  // when this message is at-or-after the current latest_customer_
  // message_at — handles the rare case where two inbound messages
  // arrive close together and scoring resolves out of order.
  if (messageCreatedAt) {
    await sql`
      update tickets set
        latest_customer_sentiment  = ${sentiment},
        latest_customer_message_at = ${messageCreatedAt}
      where id = ${ticketId} and workspace_id = ${workspaceId}
        and (latest_customer_message_at is null or latest_customer_message_at <= ${messageCreatedAt})
    `;
  }

  // Anger triggers an automatic priority bump so the ticket surfaces
  // in the agent's queue without requiring manual triage. Best-effort
  // and silent on failure — sentiment already landed, the row update
  // shouldn't block.
  if (sentiment === 'angry') {
    try {
      await bumpPriorityForAnger({ workspaceId, ticketId });
    } catch (err) {
      console.warn('[sentiment] priority bump failed:', err instanceof Error ? err.message : err);
    }
  }

  return sentiment;
}

// Priority ranks. Higher = more urgent. We bump tickets in the
// {low, normal} band up to {high}; tickets already at high or urgent
// stay where they are (a sentiment signal isn't strong enough to
// override an explicit human priority).
const PRIORITY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
const ANGER_BUMP_TARGET = 'high';

async function bumpPriorityForAnger(args: {
  workspaceId: string;
  ticketId:    string;
}): Promise<void> {
  const { workspaceId, ticketId } = args;
  const sql = getDb();

  // Workspace can opt out while keeping sentiment scoring on. Defaults to true.
  const [ws] = await sql<{ auto_priority_bump_on_angry: boolean }[]>`
    select auto_priority_bump_on_angry from workspaces where id = ${workspaceId}
  `;
  if (ws && ws.auto_priority_bump_on_angry === false) return;

  const [ticket] = await sql<{ priority_key: string }[]>`
    select priority_key from tickets
    where id = ${ticketId} and workspace_id = ${workspaceId} and deleted_at is null
  `;
  if (!ticket) return;

  const currentRank = PRIORITY_RANK[ticket.priority_key] ?? PRIORITY_RANK.normal;
  if (currentRank >= PRIORITY_RANK[ANGER_BUMP_TARGET]) return;
  const fromPriority = ticket.priority_key;

  await sql`
    update tickets set priority_key = ${ANGER_BUMP_TARGET}
    where id = ${ticketId} and workspace_id = ${workspaceId}
  `;

  // Audit row so the thread shows WHY the priority changed.
  await sql`
    insert into ticket_messages (workspace_id, ticket_id, role, author_label, body)
    values (${workspaceId}, ${ticketId}, 'system', 'System',
      ${`Priority bumped from ${fromPriority} to ${ANGER_BUMP_TARGET} — customer's last message was flagged as angry.`})
  `;
}
