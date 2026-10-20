/**
 * Pinned Anthropic Messages API price table used by the AI usage
 * ledger to stamp an `estimatedCostUsd` on every recorded call.
 *
 * Numbers are USD per 1,000,000 tokens, as published on
 * https://claude.com/pricing (October 2026 price card).
 *
 * `cacheCreationInputExtended` is the EXTENDED (1h) cache tier
 * because `AnthropicService` always sends the
 * `extended-cache-ttl-2025-04-11` beta header. The /pricing page
 * publishes the 5-minute tier directly ($2.50 for Sonnet,
 * $0.125 / $0.625 for the two Haiku tiers); the 1h tier is on
 * docs.claude.com and equals 2× the base input price for every
 * current 5.5 model ($4 / $0.20 / $1).
 *
 * Haiku 5.5 has prompt-size tiered pricing: a cheaper rate for
 * requests whose prompt stays at or below 100K tokens, and a more
 * expensive rate above that. Prompt size for the purpose of this
 * boundary is total inbound tokens (input + cacheRead +
 * cacheCreation). Sonnet 5.5 is a single flat tier.
 *
 * When Anthropic revises a price, bump `AI_PRICING_VERSION` and
 * change the constants in place — the ledger stamps the value at
 * write time, so historical rows keep whatever cost was computed
 * then (unless deliberately back-filled).
 */
export const AI_PRICING_VERSION = '2026-10';

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

/** Prompt-size threshold at which Haiku 5.5 switches to the higher
 *  tariff. Published by Anthropic as 100K tokens. Inclusive of the
 *  boundary itself. */
const HAIKU_TIER_BOUNDARY_TOKENS = 100_000;

export const SONNET_5_5: ModelPricingUsdPerMtok = {
  input: 2.0,
  output: 10.0,
  cacheReadInput: 0.1,
  cacheCreationInputExtended: 4.0,
};

export const HAIKU_5_5_LE_100K: ModelPricingUsdPerMtok = {
  input: 0.1,
  output: 0.5,
  cacheReadInput: 0.01,
  cacheCreationInputExtended: 0.2,
};

export const HAIKU_5_5_GT_100K: ModelPricingUsdPerMtok = {
  input: 0.5,
  output: 2.5,
  cacheReadInput: 0.05,
  cacheCreationInputExtended: 1.0,
};

function promptTokensOf(usage: AiUsageTokens): number {
  return (
    usage.inputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens
  );
}

export function priceForModel(
  model: string,
  usage: AiUsageTokens,
): ModelPricingUsdPerMtok | null {
  if (model.startsWith('claude-sonnet-5-5')) return SONNET_5_5;
  if (model.startsWith('claude-haiku-5-5')) {
    return promptTokensOf(usage) > HAIKU_TIER_BOUNDARY_TOKENS
      ? HAIKU_5_5_GT_100K
      : HAIKU_5_5_LE_100K;
  }
  return null;
}

export function estimateUsdCost(
  model: string,
  usage: AiUsageTokens,
): number {
  const p = priceForModel(model, usage);
  if (!p) return 0;
  const perToken = (
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadInputTokens * p.cacheReadInput +
    usage.cacheCreationInputTokens * p.cacheCreationInputExtended
  ) / 1_000_000;
  return Math.round(perToken * 1_000_000) / 1_000_000;
}
