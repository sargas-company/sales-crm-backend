import { Injectable, Logger } from '@nestjs/common';

import Anthropic from '@anthropic-ai/sdk';

import { AnthropicService } from '../anthropic/anthropic.service';
import { PromptService } from '../prompt/prompt.service';

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const VALID_DECISIONS = ['approve', 'maybe', 'decline'] as const;
const VALID_PRIORITIES = ['high', 'medium', 'low'] as const;

type Decision = (typeof VALID_DECISIONS)[number];
type Priority = (typeof VALID_PRIORITIES)[number];

export interface AiResult {
  decision: Decision;
  matchScore: number;
  priority: Priority;
  aiResponse: object;
}

@Injectable()
export class AiJobEvaluatorService {
  private readonly logger = new Logger(AiJobEvaluatorService.name);
  constructor(
    private readonly promptService: PromptService,
    private readonly anthropicService: AnthropicService,
  ) {}

  async evaluate(text: string): Promise<AiResult> {
    const system = await this.promptService.getEvaluationPrompt();
    const response = await this.anthropicService.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: text }],
    });

    const raw = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');

    this.logger.debug(`AI raw response: ${raw}`);

    const cleaned = raw
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    this.logger.debug(`AI cleaned response: ${cleaned}`);

    if (!cleaned) {
      throw new Error('Empty AI response');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`AI returned invalid JSON: ${cleaned.slice(0, 200)}`);
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`AI response is not an object: ${typeof parsed}`);
    }

    const decision = String(parsed.decision ?? '').toLowerCase();
    const priority = String(parsed.priority ?? '').toLowerCase();
    const rawScore = Number(parsed.match_score);

    if (isNaN(rawScore)) {
      throw new Error(`Invalid match_score: "${parsed.match_score}"`);
    }

    const matchScore = Math.max(0, Math.min(100, rawScore));

    if (!VALID_DECISIONS.includes(decision as Decision)) {
      throw new Error(`Invalid decision value: "${decision}"`);
    }
    if (!VALID_PRIORITIES.includes(priority as Priority)) {
      throw new Error(`Invalid priority value: "${priority}"`);
    }

    const result: AiResult = {
      decision: decision as Decision,
      matchScore,
      priority: priority as Priority,
      aiResponse: parsed,
    };

    const { usage } = response;

    this.logger.log(
      `Evaluated: decision=${result.decision} score=${result.matchScore} priority=${result.priority} | tokens in=${usage.input_tokens} out=${usage.output_tokens} cache_created=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0}`,
    );

    return result;
  }

  async gate(text: string): Promise<GateResult> {
    const system = await this.promptService.getGatekeeperPrompt();
    const response = await this.anthropicService.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 256,
      system,
      messages: [{ role: 'user', content: text }],
    });

    const raw = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    this.logger.debug(`Gatekeeper raw: ${raw}`);
    const { usage } = response;
    const result = parseGatekeeperResponse(raw);
    this.logger.log(
      `Gatekeeper: fit=${result.fit} reason="${result.reason}" | tokens in=${usage.input_tokens} out=${usage.output_tokens}`,
    );
    return result;
  }
}

export interface GateResult {
  fit: boolean;
  reason: string;
}

export class GatekeeperResponseError extends Error {
  constructor(reason: string, public readonly raw: string) {
    super(`Gatekeeper response invalid: ${reason}`);
    this.name = 'GatekeeperResponseError';
  }
}

/** Fallback when the model returns a decision but no usable reason. */
export const GATEKEEPER_REASON_FALLBACK = 'No gatekeeper reason provided';

/**
 * Pure parser separated so it can be unit-tested without an Anthropic
 * stub. Throws `GatekeeperResponseError` on a malformed response —
 * missing JSON, invalid JSON, or a `fit` that is missing / not a
 * boolean — so a bad model reply reaches the processor's existing
 * retry path (status rolls back to NEW on a non-last attempt, FAILED
 * on the last one) rather than silently flipping into `fit=true`.
 *
 * The `reason` field, by contrast, is treated as advisory metadata:
 * when it is missing, empty, or not a string we substitute
 * `GATEKEEPER_REASON_FALLBACK` and let the decision stand. The model
 * is prompted to always return it, but losing a one-line explanation
 * is not a reason to drop a valid gate decision on a backlogged
 * production pipeline.
 */
export function parseGatekeeperResponse(raw: string): GateResult {
  const sample = sanitise(raw);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new GatekeeperResponseError('no JSON object found', sample);
  }
  let parsed: { fit?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new GatekeeperResponseError('invalid JSON', sample);
  }
  if (typeof parsed.fit !== 'boolean') {
    throw new GatekeeperResponseError('fit is missing or not boolean', sample);
  }
  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
      ? parsed.reason.trim().slice(0, 200)
      : GATEKEEPER_REASON_FALLBACK;
  return { fit: parsed.fit, reason };
}

/**
 * Trim and length-cap the raw text so it can safely land in logs or
 * attached to an exception without ballooning payloads.
 */
function sanitise(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
}
