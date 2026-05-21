import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.ts';

export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// Model rate card in micro-dollars per 1M tokens (1 USD = 1_000_000 micro).
// Cache writes are 1.25× input for 5-min TTL (we don't use 1h TTL yet);
// cache reads are 0.1× input. Keep in sync with rates posted at
// https://docs.anthropic.com/en/docs/about-claude/models/overview.
type Rate = { input: number; cache_creation: number; cache_read: number; output: number };

const RATES: Record<string, Rate> = {
  'claude-opus-4-7':   { input: 5_000_000,  cache_creation: 6_250_000,  cache_read:   500_000, output: 25_000_000 },
  'claude-sonnet-4-6': { input: 3_000_000,  cache_creation: 3_750_000,  cache_read:   300_000, output: 15_000_000 },
  'claude-haiku-4-5':  { input: 1_000_000,  cache_creation: 1_250_000,  cache_read:   100_000, output:  5_000_000 },
};

export interface CostInputs {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

/**
 * Compute micro-dollar cost from a usage object. Returns 0 if the model isn't
 * in the rate card (defensive: better to log $0 than to throw inside the
 * request hot path).
 */
export function computeCostMicro(model: string, usage: CostInputs): number {
  const r = RATES[model];
  if (!r) return 0;
  // Each rate is per-1M tokens; tokens * rate / 1_000_000 gives micro-dollars.
  return Math.round(
    (usage.input_tokens                 * r.input) / 1_000_000 +
    (usage.cache_creation_input_tokens  * r.cache_creation) / 1_000_000 +
    (usage.cache_read_input_tokens      * r.cache_read) / 1_000_000 +
    (usage.output_tokens                * r.output) / 1_000_000,
  );
}
