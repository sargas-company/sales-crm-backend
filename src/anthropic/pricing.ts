/**
 * Pinned Anthropic Messages API price table used by the AI usage
 * ledger to stamp an `estimatedCostUsd` on every recorded call.
 *
 * Numbers are USD per 1,000,000 tokens. The cache row is the
 * EXTENDED (1h) cache tier because `AnthropicService` always sends
 * the `extended-cache-ttl-2025-04-11` beta header; a model whose
 * prefix we do not recognise falls back to zero cost (the row is
 * still written with the raw usage, so it stays visible).
 *
 * When Anthropic revises a price, bump `AI_PRICING_VERSION` and
 * add a new entry — historical rows keep their stamped cost under
 * the old version string, so totals never shift retroactively.
 *
 * The values below are a sensible starting pin; the owner should
 * reconcile them against the current price card in the Anthropic
 * Console before shipping (the LEDGER itself is correct regardless;
 * only the dollar column needs the final numbers).
 */
export const AI_PRICING_VERSION = '2026-01';

export interface ModelPricingUsdPerMtok {
  input: number;
  output: number;
  cacheReadInput: number;
  cacheCreationInputExtended: number;
}

export interface AiUsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

const PRICING: Array<{ prefix: string; price: ModelPricingUsdPerMtok }> = [
  {
    prefix: 'claude-sonnet-5-5',
    price: {
      input: 3,
      output: 15,
      cacheReadInput: 0.3,
      cacheCreationInputExtended: 6,
    },
  },
  {
    prefix: 'claude-haiku-5-5',
    price: {
      input: 1,
      output: 5,
      cacheReadInput: 0.1,
      cacheCreationInputExtended: 2,
    },
  },
];

export function priceForModel(model: string): ModelPricingUsdPerMtok | null {
  const match = PRICING.find((p) => model.startsWith(p.prefix));
  return match ? match.price : null;
}

export function estimateUsdCost(
  model: string,
  usage: AiUsageTokens,
): number {
  const p = priceForModel(model);
  if (!p) return 0;
  const perToken = (
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadInputTokens * p.cacheReadInput +
    usage.cacheCreationInputTokens * p.cacheCreationInputExtended
  ) / 1_000_000;
  return Math.round(perToken * 1_000_000) / 1_000_000;
}
