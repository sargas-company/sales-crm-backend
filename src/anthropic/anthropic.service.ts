import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

/**
 * The default ephemeral prompt cache TTL is 5 minutes. The 1-hour
 * TTL requires the `extended-cache-ttl-2025-04-11` beta header AND
 * an explicit `ttl: "1h"` on every cache_control breakpoint.
 *
 * Model minimums for a cacheable prefix (from Anthropic docs):
 *   • Haiku 4.5    — 4096 tokens.
 *   • Sonnet 5.5   — 1024 tokens.
 * If a system prompt is below the model's minimum, the API
 * silently ignores the cache_control marker (no cost, no benefit).
 * We do NOT pad the prompt to meet the threshold — that would waste
 * input tokens on every call. Instead we log + persist the
 * cache_read / cache_creation counters from the usage block so
 * "was the marker honoured" is directly observable: if both are 0
 * on every call, the prompt is below the threshold and caching is
 * effectively off for that stage.
 *
 * The beta header's scope is request-wide (`anthropic-beta: ...`
 * on the HTTP request), so setting it on the Anthropic client's
 * `defaultHeaders` covers every stage without a per-call opt-in.
 */
const EXTENDED_CACHE_BETA = 'extended-cache-ttl-2025-04-11';

@Injectable()
export class AnthropicService {
  readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultHeaders: {
        'anthropic-beta': EXTENDED_CACHE_BETA,
      },
    });
  }
}
