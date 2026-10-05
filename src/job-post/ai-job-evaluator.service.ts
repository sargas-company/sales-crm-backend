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
      // Forced tool_use is Anthropic's structured-output mechanism:
      // the API validates the model's output against `input_schema`
      // and will not return a tool_use block whose `input` violates
      // the schema. We never parse freeform text for the gatekeeper
      // decision any more.
      tools: [GATEKEEPER_TOOL],
      tool_choice: { type: 'tool', name: GATEKEEPER_TOOL.name },
    });

    const toolUse = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use',
    );
    if (!toolUse) {
      throw new GatekeeperResponseError(
        'no tool_use block returned',
        sanitise(JSON.stringify(response.content ?? '')),
      );
    }
    const { usage } = response;
    const result = parseGatekeeperInput(toolUse.input);
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

/**
 * The schema the Anthropic API uses to validate the gatekeeper's
 * structured output. Both fields are required; `reason` is bounded
 * at 1..200 characters so a vacuous empty string cannot slip
 * through. `additionalProperties: false` keeps the surface tight so
 * silent prompt drift (an extra "confidence", "notes" field) raises
 * a server-side validation error that reaches our retry path.
 */
export const GATEKEEPER_TOOL: Anthropic.Tool = {
  name: 'record_gatekeeper_decision',
  description:
    'Return the gatekeeper decision for the current job post. Must be called exactly once with both fit and a short non-empty reason.',
  input_schema: {
    type: 'object',
    properties: {
      fit: {
        type: 'boolean',
        description:
          'True if the post should proceed to full AI evaluation, false if it should be rejected at the gate.',
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'A short factual explanation (<= 200 chars) of the decision. Required for both fit=true and fit=false.',
      },
    },
    required: ['fit', 'reason'],
    additionalProperties: false,
  },
};

export class GatekeeperResponseError extends Error {
  constructor(reason: string, public readonly raw: string) {
    super(`Gatekeeper response invalid: ${reason}`);
    this.name = 'GatekeeperResponseError';
  }
}

/**
 * Pure parser for a `tool_use.input` payload produced by the forced
 * `record_gatekeeper_decision` tool call. The Anthropic API already
 * validates the shape against `GATEKEEPER_TOOL.input_schema`, but we
 * still re-check at the application boundary so a hypothetical
 * server-side regression or an upstream shim cannot leak an invalid
 * decision into the pipeline. Throws `GatekeeperResponseError` on
 * every violation — the processor's existing retry path (status
 * rolls back to NEW on a non-last attempt, FAILED on the last) takes
 * it from there. We intentionally do NOT fall back to a placeholder
 * reason: an empty or missing reason is a protocol violation, not
 * recoverable metadata loss.
 */
export function parseGatekeeperInput(raw: unknown): GateResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GatekeeperResponseError(
      'tool input is not an object',
      sanitise(JSON.stringify(raw ?? '')),
    );
  }
  const obj = raw as { fit?: unknown; reason?: unknown };
  const sample = sanitise(JSON.stringify(obj));
  if (typeof obj.fit !== 'boolean') {
    throw new GatekeeperResponseError('fit is missing or not boolean', sample);
  }
  if (typeof obj.reason !== 'string') {
    throw new GatekeeperResponseError('reason is missing or not string', sample);
  }
  const trimmed = obj.reason.trim();
  if (trimmed.length === 0) {
    throw new GatekeeperResponseError('reason is empty', sample);
  }
  // The schema already caps at 200, but a defensive slice protects
  // against any upstream drift and matches historical behaviour.
  return { fit: obj.fit, reason: trimmed.slice(0, 200) };
}

/**
 * Trim and length-cap the sampled payload so it can safely land in
 * logs or attached to an exception without ballooning.
 */
function sanitise(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
}
