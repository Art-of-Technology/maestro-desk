import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anthropic, computeCostMicro } from './anthropic.ts';
import { assertHasBudget, BudgetExceededError, deductBudget } from './budget.ts';

const MODEL = 'claude-sonnet-4-6';

// ─── Tool schema ───────────────────────────────────────────────────────────
// Single tool the model is forced to call. Captures everything we need from
// one round-trip: classification, summary, draft reply, AI tags.

const RECORD_TRIAGE_TOOL: Anthropic.Tool = {
  name: 'record_triage',
  description:
    'Record the AI triage for this ticket. You MUST call this tool exactly once with the complete result.',
  input_schema: {
    type: 'object',
    properties: {
      category_key: {
        type: 'string',
        description:
          'The category key (not label) that best matches this ticket. Must be from the AVAILABLE CATEGORIES list.',
      },
      priority_key: {
        type: 'string',
        description:
          'The priority key (not label) that best matches the urgency. Must be from the AVAILABLE PRIORITIES list.',
      },
      sentiment: {
        type: 'string',
        enum: ['positive', 'neutral', 'frustrated', 'angry'],
        description: "The customer's emotional state, judged from their language.",
      },
      summary: {
        type: 'string',
        description:
          'One short paragraph (max 3 sentences) describing the issue, written for an agent picking up the ticket cold. Lead with the symptom, then what we know, then what is blocking resolution.',
      },
      draft_reply: {
        type: 'string',
        description:
          'A suggested first-response reply to the customer. Empathetic, specific to their issue, no fake timelines, no fake commitments. Sign off as the workspace name (no fake agent names). Plain text, no greeting line if the thread already has agent replies.',
      },
      tags: {
        type: 'array',
        description:
          '3-6 short topical tags (lowercase, hyphenated, no spaces). Examples: "checkout-error", "billing-dispute", "password-reset".',
        items: {
          type: 'object',
          properties: {
            tag: { type: 'string' },
            confidence: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description: 'How confident you are this tag applies, 0-100.',
            },
          },
          required: ['tag', 'confidence'],
        },
      },
      confidence: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description:
          'Overall triage confidence 0-100. Above 85 means high enough to consider auto-reply for trivial categories. Below 60 means the ticket is ambiguous and needs human triage.',
      },
    },
    required: [
      'category_key',
      'priority_key',
      'sentiment',
      'summary',
      'draft_reply',
      'tags',
      'confidence',
    ],
  },
};

// Runtime validation of the tool input — defence-in-depth against model drift.
const TriageOutput = z.object({
  category_key: z.string().min(1),
  priority_key: z.string().min(1),
  sentiment: z.enum(['positive', 'neutral', 'frustrated', 'angry']),
  summary: z.string().min(1),
  draft_reply: z.string().min(1),
  tags: z
    .array(z.object({ tag: z.string().min(1), confidence: z.number().int().min(0).max(100) }))
    .min(0)
    .max(10),
  confidence: z.number().int().min(0).max(100),
});

export type TriageOutput = z.infer<typeof TriageOutput>;

// ─── Prompt assembly ───────────────────────────────────────────────────────

const SYSTEM_INTRO = `You are the triage AI for Maestro Desk, a customer-support help desk. Your job is to read an incoming support ticket and call the record_triage tool exactly once with a complete, accurate result.

Rules:
- Pick the SINGLE BEST category and priority from the lists provided. Use the exact keys, not the labels.
- Priority guidance: "urgent" = revenue-blocking, security, GDPR statutory deadline. "high" = customer-blocked but workaround exists. "normal" = standard issue. "low" = feature request, informational.
- Sentiment: judge from word choice, exclamation marks, all-caps. Default to "neutral" if unsure.
- Summary: lead with the symptom in concrete terms. Avoid filler like "the customer is asking about". An agent should be able to pick up the ticket after reading just the summary.
- Draft reply: write what an experienced support agent would write. Acknowledge the issue, state what you'll do or what you already see, and ask for specifics if needed. NO fake timelines ("within 24 hours"). NO fake commitments. NO promises to "look into it" without saying what.
- Tags: 3-6 short kebab-case tags. Prefer existing taxonomy ("billing", "checkout", "mobile-bug") over inventing new ones.
- Confidence: be honest. If the ticket is ambiguous or you couldn't find a good category, lower the confidence so a human reviews it.
`;

interface WorkspaceLookups {
  categories: { key: string; label: string }[];
  priorities: { key: string; label: string }[];
  statuses: { key: string; label: string }[];
}

function buildWorkspaceContext(lookups: WorkspaceLookups): string {
  const cats = lookups.categories.map((c) => `  - ${c.key} (${c.label})`).join('\n');
  const prios = lookups.priorities.map((p) => `  - ${p.key} (${p.label})`).join('\n');
  const stats = lookups.statuses.map((s) => `  - ${s.key} (${s.label})`).join('\n');
  return `AVAILABLE CATEGORIES (use one of these keys):
${cats}

AVAILABLE PRIORITIES (use one of these keys):
${prios}

AVAILABLE STATUSES (for context only — you do not set status):
${stats}`;
}

interface TicketSnapshot {
  display_id: string;
  subject: string;
  current_category_key: string | null;
  current_priority_key: string | null;
  current_status_key: string;
  customer_label: string;
  customer_vip_tier: string | null;
  customer_brand: string | null;
  customer_jurisdiction: string | null;
  messages: { role: string; author_label: string; body: string; created_at: string }[];
}

function buildUserMessage(t: TicketSnapshot): string {
  const thread = t.messages
    .map((m) => `[${m.created_at} · ${m.role.toUpperCase()} · ${m.author_label}]\n${m.body}`)
    .join('\n\n---\n\n');
  return `Triage ticket ${t.display_id}.

CUSTOMER: ${t.customer_label}${t.customer_vip_tier ? ` · VIP ${t.customer_vip_tier}` : ''}${t.customer_brand ? ` · ${t.customer_brand}` : ''}${t.customer_jurisdiction ? ` · ${t.customer_jurisdiction}` : ''}
CURRENT STATUS: ${t.current_status_key}
CURRENT CATEGORY: ${t.current_category_key ?? '(none)'}
CURRENT PRIORITY: ${t.current_priority_key ?? '(none)'}
SUBJECT: ${t.subject}

THREAD (oldest first):
${thread}

Call record_triage now with the complete result.`;
}

// ─── Main entry ────────────────────────────────────────────────────────────

export interface TriageInput {
  ticketId: string;
  workspaceId: string;
  userId: string;
  sb: SupabaseClient;
}

export interface TriageResult {
  triage: TriageOutput;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    cost_usd_micro: number;
    duration_ms: number;
    model: string;
  };
  budget: {
    balance_after_micro: number | null;  // null if deduct failed (logged server-side)
  };
}

export class TriageError extends Error {
  constructor(message: string, public status: number = 500) {
    super(message);
  }
}

export async function triageTicket(input: TriageInput): Promise<TriageResult> {
  const { ticketId, workspaceId, userId, sb } = input;

  // 0. Budget gate — refuse cheaply before doing any work. Log the blocked
  //    attempt so we have telemetry on how often this fires.
  try {
    await assertHasBudget(sb, workspaceId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await sb.from('ai_usage_log').insert({
        workspace_id: workspaceId,
        ticket_id: ticketId,
        user_id: userId,
        action: 'triage_blocked_no_budget',
        model: MODEL,
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        cost_usd_micro: 0,
        duration_ms: 0,
        request_id: null,
      });
    }
    throw err;
  }

  // 1. Load the ticket + thread + customer in parallel with the lookups.
  const [ticketRes, lookups] = await Promise.all([
    loadTicketSnapshot(sb, ticketId, workspaceId),
    loadWorkspaceLookups(sb, workspaceId),
  ]);

  // 2. Build the prompt. System has TWO blocks: stable intro + per-workspace
  //    lookups. cache_control on the LAST system block caches both together
  //    (render order is tools → system → messages, so tools are cached too).
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_INTRO },
    {
      type: 'text',
      text: buildWorkspaceContext(lookups),
      cache_control: { type: 'ephemeral' },
    },
  ];

  const userMessage = buildUserMessage(ticketRes);

  // 3. Call Claude with tool_choice forcing the tool. We deliberately do NOT
  //    enable adaptive thinking here — the Anthropic API rejects the
  //    combination ("Thinking may not be enabled when tool_choice forces tool
  //    use."). Sonnet 4.6 produces strong triage output without thinking,
  //    and the structured-output guarantee from forced tool_choice is more
  //    valuable than the marginal quality bump from adaptive thinking.
  //    If we want thinking back, switch to tool_choice {type: "auto"} and
  //    handle the (rare) case where the model returns text instead.
  const startedAt = Date.now();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [RECORD_TRIAGE_TOOL],
    tool_choice: { type: 'tool', name: 'record_triage' },
    system,
    messages: [{ role: 'user', content: userMessage }],
  });
  const durationMs = Date.now() - startedAt;

  // Compute the cost once — used by logUsage, deductBudget, and the response.
  // Failure paths still pay Anthropic (tokens were spent) so they deduct too.
  const costMicro = computeCostMicro(MODEL, {
    input_tokens: response.usage.input_tokens,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    output_tokens: response.usage.output_tokens,
  });

  // 4. Extract + validate the tool call.
  const toolUseBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_triage',
  );
  if (!toolUseBlock) {
    await Promise.all([
      logUsage({
        sb, workspaceId, ticketId, userId,
        action: 'triage_failed_no_tool_use',
        model: MODEL,
        usage: response.usage,
        durationMs,
        requestId: response.id,
      }),
      deductBudget(sb, workspaceId, costMicro),
    ]);
    throw new TriageError('Model did not call record_triage', 502);
  }
  const parsed = TriageOutput.safeParse(toolUseBlock.input);
  if (!parsed.success) {
    await Promise.all([
      logUsage({
        sb, workspaceId, ticketId, userId,
        action: 'triage_failed_schema',
        model: MODEL,
        usage: response.usage,
        durationMs,
        requestId: response.id,
      }),
      deductBudget(sb, workspaceId, costMicro),
    ]);
    throw new TriageError(
      `Triage output failed schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      502,
    );
  }
  const triage = parsed.data;

  // 5. Validate category/priority keys exist in the workspace lookups (model
  //    occasionally hallucinates close-but-not-exact keys).
  if (!lookups.categories.find((c) => c.key === triage.category_key)) {
    triage.category_key = ticketRes.current_category_key ?? lookups.categories[0]?.key ?? '';
  }
  if (!lookups.priorities.find((p) => p.key === triage.priority_key)) {
    triage.priority_key = ticketRes.current_priority_key ?? 'normal';
  }

  // 6. Persist in parallel: update ticket + replace AI tags + log usage + deduct budget.
  const [, , , balanceAfterMicro] = await Promise.all([
    persistTicketTriage(sb, ticketId, workspaceId, triage),
    persistAITags(sb, ticketId, workspaceId, triage.tags),
    logUsage({
      sb, workspaceId, ticketId, userId,
      action: 'triage',
      model: MODEL,
      usage: response.usage,
      durationMs,
      requestId: response.id,
    }),
    deductBudget(sb, workspaceId, costMicro),
  ]);

  return {
    triage,
    usage: {
      input_tokens: response.usage.input_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      output_tokens: response.usage.output_tokens,
      cost_usd_micro: costMicro,
      duration_ms: durationMs,
      model: MODEL,
    },
    budget: {
      balance_after_micro: balanceAfterMicro,
    },
  };
}

// ─── Supabase helpers ──────────────────────────────────────────────────────

async function loadTicketSnapshot(
  sb: SupabaseClient,
  ticketId: string,
  workspaceId: string,
): Promise<TicketSnapshot> {
  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .select(
      'id, display_id, subject, status_key, priority_key, category_key, customer_id, customers(first_name, last_name, vip_tier, brand, jurisdiction)',
    )
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .single();
  if (tErr || !ticket) throw new TriageError(`Ticket not found: ${tErr?.message ?? 'unknown'}`, 404);

  const { data: msgs, error: mErr } = await sb
    .from('ticket_messages')
    .select('role, author_label, body, created_at')
    .eq('ticket_id', ticketId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (mErr) throw new TriageError(`Failed to load messages: ${mErr.message}`, 500);

  // customers is an array because the select used a relation join; flatten.
  const c = (Array.isArray(ticket.customers) ? ticket.customers[0] : ticket.customers) as
    | { first_name: string | null; last_name: string | null; vip_tier: string | null; brand: string | null; jurisdiction: string | null }
    | null;

  return {
    display_id: ticket.display_id,
    subject: ticket.subject,
    current_category_key: ticket.category_key,
    current_priority_key: ticket.priority_key,
    current_status_key: ticket.status_key,
    customer_label: c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || '(unknown)' : '(unknown)',
    customer_vip_tier: c?.vip_tier ?? null,
    customer_brand: c?.brand ?? null,
    customer_jurisdiction: c?.jurisdiction ?? null,
    messages: msgs ?? [],
  };
}

async function loadWorkspaceLookups(
  sb: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceLookups> {
  const [cats, prios, stats] = await Promise.all([
    sb.from('ticket_categories').select('key, label').eq('workspace_id', workspaceId).order('label'),
    sb.from('ticket_priorities').select('key, label').eq('workspace_id', workspaceId).order('sort_order'),
    sb.from('ticket_statuses').select('key, label').eq('workspace_id', workspaceId).order('sort_order'),
  ]);
  if (cats.error || prios.error || stats.error) {
    throw new TriageError(
      `Failed to load lookups: ${cats.error?.message ?? prios.error?.message ?? stats.error?.message}`,
      500,
    );
  }
  return {
    categories: cats.data ?? [],
    priorities: prios.data ?? [],
    statuses: stats.data ?? [],
  };
}

async function persistTicketTriage(
  sb: SupabaseClient,
  ticketId: string,
  workspaceId: string,
  triage: TriageOutput,
) {
  const now = new Date().toISOString();
  const { error } = await sb
    .from('tickets')
    .update({
      ai_summary: {
        text: triage.summary,
        sentiment: triage.sentiment,
        confidence: triage.confidence,
        suggested_category_key: triage.category_key,
        suggested_priority_key: triage.priority_key,
        model: MODEL,
        generated_at: now,
      },
      ai_draft_reply: {
        text: triage.draft_reply,
        confidence: triage.confidence,
        model: MODEL,
        generated_at: now,
      },
    })
    .eq('id', ticketId)
    .eq('workspace_id', workspaceId);
  if (error) throw new TriageError(`Failed to persist triage: ${error.message}`, 500);
}

async function persistAITags(
  sb: SupabaseClient,
  ticketId: string,
  workspaceId: string,
  tags: TriageOutput['tags'],
) {
  // Wipe and replace — simpler than diff/upsert, and AI tags are derived data
  // we can always re-generate from another triage call.
  const del = await sb.from('ticket_ai_tags').delete().eq('ticket_id', ticketId);
  if (del.error) throw new TriageError(`Failed to clear AI tags: ${del.error.message}`, 500);
  if (tags.length === 0) return;
  const ins = await sb.from('ticket_ai_tags').insert(
    tags.map((t) => ({
      workspace_id: workspaceId,
      ticket_id: ticketId,
      tag: t.tag,
      confidence: t.confidence,
      accepted: false,
    })),
  );
  if (ins.error) throw new TriageError(`Failed to insert AI tags: ${ins.error.message}`, 500);
}

async function logUsage(args: {
  sb: SupabaseClient;
  workspaceId: string;
  ticketId: string;
  userId: string;
  action: string;
  model: string;
  usage: Anthropic.Usage;
  durationMs: number;
  requestId?: string;
}) {
  const input_tokens = args.usage.input_tokens;
  const cache_creation_input_tokens = args.usage.cache_creation_input_tokens ?? 0;
  const cache_read_input_tokens = args.usage.cache_read_input_tokens ?? 0;
  const output_tokens = args.usage.output_tokens;
  const cost = computeCostMicro(args.model, {
    input_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    output_tokens,
  });
  // Best-effort logging — failure to log usage should not break the request.
  const { error } = await args.sb.from('ai_usage_log').insert({
    workspace_id: args.workspaceId,
    ticket_id: args.ticketId,
    user_id: args.userId,
    action: args.action,
    model: args.model,
    input_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    output_tokens,
    cost_usd_micro: cost,
    duration_ms: args.durationMs,
    request_id: args.requestId ?? null,
  });
  if (error) console.error('ai_usage_log insert failed:', error.message);
}
