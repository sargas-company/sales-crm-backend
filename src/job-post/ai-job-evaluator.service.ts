import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import Anthropic from '@anthropic-ai/sdk';

import { AiUsageLedgerService } from '../ai-usage-ledger/ai-usage-ledger.service';
import { AnthropicService } from '../anthropic/anthropic.service';
import { PromptService } from '../prompt/prompt.service';

/**
 * Phase B — two-stage AI pipeline for job-post triage.
 *
 *   1. Gatekeeper (Haiku 5.5) returns { fit, confidence, reason }
 *      via `tool_choice: auto`. The processor rejects at the gate
 *      ONLY when `fit=false AND confidence >= GATE_REJECT_THRESHOLD`.
 *      Everything else (fit=true, or low-confidence false) goes
 *      through to the evaluator.
 *   2. Evaluator (Sonnet 5.5) returns the full structured verdict
 *      (decision / matchScore / priority / reasoning / strengths /
 *      risks / scopeClarity / quickWin / effortEstimate).
 *
 * Prompt caching: both stages mark the stable system prompt with
 * `cache_control: { type: "ephemeral", ttl: "1h" }`. The 1-hour TTL
 * requires the `extended-cache-ttl-2025-04-11` beta header applied
 * at the SDK client level (see AnthropicService). The cacheable
 * minimum for both Claude 5.5 models is **512 tokens** per
 * Anthropic's cache docs — prompts below that silently drop the
 * marker, and the only authoritative "cache is working" signal is
 * `cache_read_input_tokens > 0` in the usage block.
 *
 * Thinking configuration is model-specific — the two models have
 * different sets of accepted shapes on the Messages API as of the
 * Claude 5.5 migration guides:
 *   • Haiku 5.5
 *       — Omitting `thinking` with `tool_choice: 'auto'` does NOT
 *         disable thinking: `adaptive` is on by default. The
 *         documented no-thinking path is **forced tool_choice** —
 *         `tool_choice: { type: 'tool', name: <tool.name> }` with
 *         the gate tool. The response begins with the tool_use
 *         block directly, with no leading thinking block.
 *         `{enabled, budget_tokens}` is rejected with 400 (legacy
 *         Claude 4.x). Haiku's gate therefore sends NO `thinking`
 *         field at all and relies on forced tool_choice.
 *   • Sonnet 5.5
 *       — Neither `disabled` nor `enabled + budget_tokens` is
 *         accepted (400). The documented shape is TWO top-level
 *         fields on the Messages request:
 *             thinking:      { type: 'between_tools' | 'adaptive' }
 *             output_config: { effort: 'low' | 'medium' | 'high' }
 *         `effort` is NOT nested inside `thinking`;
 *         `output_config` is NOT nested inside `thinking`.
 *       Overridable per environment via `CLAUDE_SONNET_THINKING`
 *       (format: `between_tools:<effort>` or `adaptive:<effort>`).
 *       Unset → `between_tools:low`. Actual thinking-token spend
 *       must be confirmed from the response `usage` block —
 *       between_tools is not a guaranteed-zero-cost configuration.
 *
 * We therefore ship a **separate request builder per model**
 * (`buildGateRequest` for Haiku, `buildEvalRequest` for Sonnet)
 * so one shape never leaks into the other.
 *
 * Model IDs: `claude-haiku-5-5` and `claude-sonnet-5-5` (no date
 * suffix — Anthropic's public SDK accepts these as the current
 * production family IDs). Override via `CLAUDE_MODEL_GATE` /
 * `CLAUDE_MODEL_EVAL` for a different pin.
 */

const DEFAULT_GATE_MODEL = 'claude-haiku-5-5';
const DEFAULT_EVAL_MODEL = 'claude-sonnet-5-5';

const GATE_MAX_TOKENS = 256;
const EVAL_MAX_TOKENS = 1024;

type SonnetThinkingEffort = 'low' | 'medium' | 'high';
type SonnetThinkingMode = 'between_tools' | 'adaptive';

interface SonnetThinkingPair {
  thinking: { type: SonnetThinkingMode };
  output_config: { effort: SonnetThinkingEffort };
}

export const GATE_REJECT_THRESHOLD = 0.9;

const VALID_DECISIONS = ['approve', 'maybe', 'decline'] as const;
const VALID_PRIORITIES = ['high', 'medium', 'low'] as const;

type Decision = (typeof VALID_DECISIONS)[number];
type Priority = (typeof VALID_PRIORITIES)[number];

export interface AiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  // Allow storing in a Prisma `Json` column via spread; no actual
  // dynamic keys are set at runtime.
  [extra: string]: string | number;
}

export interface GateResult {
  fit: boolean;
  confidence: number;
  reason: string;
  usage: AiUsage;
}

/**
 * v2 subscores — pure sum (no penalty), max 100.
 *   core_fit          0-45
 *   project_quality   0-15
 *   client_signals    0-15
 *   budget_rate       0-15
 *   strategic_upside  0-10
 * All keys optional on the TS type so historical responses (which
 * carried `project_type_complexity`, `rate_budget_signal`, etc.)
 * don't fail type assertions when read back; the parser rejects
 * mis-named NEW responses at ingest.
 */
export interface EvalSubscores {
  core_fit?: number;
  project_quality?: number;
  client_signals?: number;
  budget_rate?: number;
  strategic_upside?: number;
}

export interface EvalResult {
  decision: Decision;
  matchScore: number;
  priority: Priority;
  // v2 envelope.
  shortSummary: string;
  reasons: string[];
  redFlags: string[];
  hardStop: boolean;
  hardStopReason: string | null;
  subscores: EvalSubscores | null;
  // Legacy (v1) — optional, populated only when the model
  // happens to return the old shape. New prompt will not emit
  // these; keeping them typed lets historical rows round-trip.
  reasoning?: string | null;
  strengths?: string[];
  risks?: string[];
  scopeClarity?: string | null;
  quickWin?: string | null;
  effortEstimate?: string | null;
  usage: AiUsage;
  raw: Record<string, unknown>;
}

@Injectable()
export class AiJobEvaluatorService {
  private readonly logger = new Logger(AiJobEvaluatorService.name);

  constructor(
    private readonly promptService: PromptService,
    private readonly anthropicService: AnthropicService,
    private readonly config: ConfigService,
    private readonly usageLedger: AiUsageLedgerService,
  ) {}

  gateModel(): string {
    return this.config.get<string>('CLAUDE_MODEL_GATE', DEFAULT_GATE_MODEL);
  }

  evalModel(): string {
    return this.config.get<string>('CLAUDE_MODEL_EVAL', DEFAULT_EVAL_MODEL);
  }

  /**
   * Parses `CLAUDE_SONNET_THINKING` into Sonnet 5.5's documented
   * shape — two **top-level** fields on the Messages request:
   *     thinking:      { type: 'between_tools' | 'adaptive' }
   *     output_config: { effort: 'low' | 'medium' | 'high' }
   * `effort` is NOT nested inside `thinking`; `output_config` is
   * NOT nested inside `thinking`. Format: `<mode>:<effort>`.
   * Default: `between_tools:low` — thinking only runs between tool
   * calls on a multi-tool trajectory. Actual thinking-token
   * accounting must be confirmed from the `usage` block of real
   * responses before claiming the cost is zero.
   */
  resolveSonnetThinking(): SonnetThinkingPair {
    const raw = this.config.get<string>('CLAUDE_SONNET_THINKING', 'between_tools:low');
    const [modeRaw, effortRaw] = String(raw).split(':', 2);
    const effort = normaliseEffort(effortRaw);
    const mode: SonnetThinkingMode =
      (modeRaw ?? '').trim() === 'adaptive' ? 'adaptive' : 'between_tools';
    return {
      thinking: { type: mode },
      output_config: { effort },
    };
  }

  /**
   * Builds the request body the SDK sends to Anthropic. Factored
   * out so tests can assert the on-wire shape (model, system +
   * cache_control, tools, tool_choice) without actually hitting
   * the API.
   *
   * Why `tool_choice: {type: 'auto'}` instead of `{type: 'tool'}`:
   * the newer Claude 5.x family refuses forced `tool_choice:
   * tool/any` with a 400 at the API boundary. `auto` is accepted
   * everywhere and still steers the model toward the tool
   * (there's only one tool advertised and the system prompt
   * directs it there). We parse either a `tool_use` block OR a
   * JSON `text` block, applying the same schema validator on
   * both paths — forced output isn't a correctness guarantee
   * anyway (there is no `strict` mode in Anthropic as of this
   * writing), so server-side validation is where the real
   * contract lives.
   */
  /**
   * Haiku 5.5 request. **Forced tool_choice** by name of the
   * gatekeeper tool: this is the documented no-thinking path on
   * Haiku 5.5. Omitting `thinking` is NOT enough on 5.5 —
   * `adaptive` thinking is on by default when `tool_choice: 'auto'`
   * is paired with any tool, which would silently add thinking
   * tokens to a decision that doesn't need them. Forcing the tool
   * makes the response begin with the tool_use block directly,
   * with no leading thinking block.
   *
   * The `thinking` field is NOT sent — the legacy
   * `{enabled, budget_tokens}` shape is rejected with 400 and
   * `{disabled}` was removed from Claude 5.5's accepted shapes.
   * Sampling knobs (`temperature`, `top_p`, `top_k`) are also not
   * sent. Response validation + `stop_reason === 'max_tokens'`
   * handling is unchanged from the Haiku 4.x pipeline.
   */
  buildGateRequest(
    systemText: string,
    userText: string,
    model: string,
  ): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model,
      max_tokens: GATE_MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: systemText,
          cache_control: { type: 'ephemeral', ttl: '1h' } as never,
        },
      ],
      messages: [{ role: 'user', content: userText }],
      tools: [GATEKEEPER_TOOL],
      tool_choice: { type: 'tool', name: GATEKEEPER_TOOL.name },
    };
  }

  /**
   * Sonnet 5.5 request. Thinking is configured through **two
   * top-level fields** per the migration guide:
   *   • `thinking: { type: 'between_tools' | 'adaptive' }`
   *   • `output_config: { effort: 'low' | 'medium' | 'high' }`
   * `effort` is NOT nested inside `thinking`. The legacy
   * `{ type: 'disabled' }` and `{ type: 'enabled', budget_tokens: N }`
   * shapes are rejected with 400 and are NEVER emitted here.
   *
   * Default: `thinking.type='between_tools'`, `effort='low'`. We
   * ALSO keep `tool_choice: 'auto'` because Sonnet 5.5 explicitly
   * supports `between_tools` thinking on auto-tool trajectories;
   * forced tool_choice is reserved for Haiku's single-tool
   * decision path.
   */
  buildEvalRequest(
    systemText: string,
    userText: string,
    model: string,
  ): Anthropic.MessageCreateParamsNonStreaming {
    const { thinking, output_config } = this.resolveSonnetThinking();
    return {
      model,
      max_tokens: EVAL_MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: systemText,
          cache_control: { type: 'ephemeral', ttl: '1h' } as never,
        },
      ],
      messages: [{ role: 'user', content: userText }],
      tools: [EVALUATOR_TOOL],
      tool_choice: { type: 'auto' },
      thinking: thinking as never,
      output_config: output_config as never,
    } as Anthropic.MessageCreateParamsNonStreaming;
  }

  async gate(text: string): Promise<GateResult> {
    const system = await this.promptService.getGatekeeperPrompt();
    const model = this.gateModel();
    const req = this.buildGateRequest(system, text, model);
    const t0 = Date.now();
    const response = await this.anthropicService.client.messages.create(req);
    void this.usageLedger.record({
      model,
      operation: 'job-eval:gate',
      usage: extractUsage(response.usage, model),
      latencyMs: Date.now() - t0,
      requestId: response.id ?? null,
    });
    if (response.stop_reason === 'max_tokens') {
      throw new GatekeeperResponseError(
        'response truncated (max_tokens)',
        sanitise(JSON.stringify(response.content ?? '')),
      );
    }
    const raw = extractStructuredPayload(
      response,
      GATEKEEPER_TOOL.name,
      (reason, sample) => new GatekeeperResponseError(reason, sample),
    );
    const parsed = parseGatekeeperInput(raw);
    const usage = extractUsage(response.usage, model);
    this.logger.log(
      `Gatekeeper(${model}): fit=${parsed.fit} conf=${parsed.confidence} reason="${parsed.reason}"` +
        ` | tok in=${usage.inputTokens} out=${usage.outputTokens}` +
        ` cache(r=${usage.cacheReadInputTokens}, w=${usage.cacheCreationInputTokens})`,
    );
    return { ...parsed, usage };
  }

  async evaluate(text: string): Promise<EvalResult> {
    const system = await this.promptService.getEvaluationPrompt();
    const model = this.evalModel();
    const req = this.buildEvalRequest(system, text, model);
    const t0 = Date.now();
    const response = await this.anthropicService.client.messages.create(req);
    void this.usageLedger.record({
      model,
      operation: 'job-eval:evaluate',
      usage: extractUsage(response.usage, model),
      latencyMs: Date.now() - t0,
      requestId: response.id ?? null,
    });
    if (response.stop_reason === 'max_tokens') {
      throw new EvaluatorResponseError(
        'response truncated (max_tokens)',
        sanitise(JSON.stringify(response.content ?? '')),
      );
    }
    const raw = extractStructuredPayload(
      response,
      EVALUATOR_TOOL.name,
      (reason, sample) => new EvaluatorResponseError(reason, sample),
    );
    const parsed = parseEvaluatorInput(raw);
    const usage = extractUsage(response.usage, model);
    this.logger.log(
      `Evaluator(${model}): decision=${parsed.decision} score=${parsed.matchScore} priority=${parsed.priority}` +
        ` | tok in=${usage.inputTokens} out=${usage.outputTokens}` +
        ` cache(r=${usage.cacheReadInputTokens}, w=${usage.cacheCreationInputTokens})`,
    );
    return { ...parsed, usage };
  }
}

// ─── Gatekeeper tool ─────────────────────────────────────────────────

export const GATEKEEPER_TOOL: Anthropic.Tool = {
  name: 'record_gatekeeper_decision',
  description:
    'Return the gatekeeper decision for the current job post. Must be called exactly once with fit, confidence, and a short non-empty reason.',
  input_schema: {
    type: 'object',
    properties: {
      fit: {
        type: 'boolean',
        description:
          'True if the post should proceed to full AI evaluation, false if it should be rejected at the gate.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Confidence in the fit decision, 0.0–1.0. The processor rejects at the gate ONLY when fit=false AND confidence >= 0.9. Low-confidence false decisions still proceed to full evaluation.',
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'A short factual explanation (<= 200 chars) of the decision. Required for every call.',
      },
    },
    required: ['fit', 'confidence', 'reason'],
    additionalProperties: false,
  },
};

// ─── Evaluator tool ──────────────────────────────────────────────────

export const EVALUATOR_TOOL: Anthropic.Tool = {
  name: 'record_job_evaluation',
  description:
    'Record the final evaluation for the current job post using the v2 envelope. Must be called exactly once with all required fields.',
  input_schema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['approve', 'maybe', 'decline'],
      },
      match_score: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
      },
      priority: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
      },
      hard_stop: {
        type: 'boolean',
      },
      hard_stop_reason: {
        type: 'string',
        maxLength: 240,
        description:
          'Short freeform explanation when hard_stop=true; empty string otherwise.',
      },
      reasons: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string', minLength: 1, maxLength: 240 },
        description: 'Bulleted reasons supporting the decision.',
      },
      red_flags: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string', minLength: 1, maxLength: 240 },
        description: 'Specific risk/red-flag notes.',
      },
      short_summary: {
        type: 'string',
        minLength: 1,
        maxLength: 1200,
        description: '1-2 sentences capturing the essence of the decision.',
      },
      subscores: {
        type: 'object',
        properties: {
          core_fit: { type: 'integer', minimum: 0, maximum: 45 },
          project_quality: { type: 'integer', minimum: 0, maximum: 15 },
          client_signals: { type: 'integer', minimum: 0, maximum: 15 },
          budget_rate: { type: 'integer', minimum: 0, maximum: 15 },
          strategic_upside: { type: 'integer', minimum: 0, maximum: 10 },
        },
        required: [
          'core_fit',
          'project_quality',
          'client_signals',
          'budget_rate',
          'strategic_upside',
        ],
        additionalProperties: false,
      },
    },
    required: [
      'decision',
      'match_score',
      'priority',
      'hard_stop',
      'hard_stop_reason',
      'reasons',
      'red_flags',
      'short_summary',
      'subscores',
    ],
    additionalProperties: false,
  },
};

export class GatekeeperResponseError extends Error {
  constructor(reason: string, public readonly raw: string) {
    super(`Gatekeeper response invalid: ${reason}`);
    this.name = 'GatekeeperResponseError';
  }
}

export class EvaluatorResponseError extends Error {
  constructor(reason: string, public readonly raw: string) {
    super(`Evaluator response invalid: ${reason}`);
    this.name = 'EvaluatorResponseError';
  }
}

export function parseGatekeeperInput(
  raw: unknown,
): Omit<GateResult, 'usage'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GatekeeperResponseError(
      'tool input is not an object',
      sanitise(JSON.stringify(raw ?? '')),
    );
  }
  const obj = raw as {
    fit?: unknown;
    confidence?: unknown;
    reason?: unknown;
  };
  const sample = sanitise(JSON.stringify(obj));
  if (typeof obj.fit !== 'boolean') {
    throw new GatekeeperResponseError('fit is missing or not boolean', sample);
  }
  if (
    typeof obj.confidence !== 'number' ||
    !Number.isFinite(obj.confidence) ||
    obj.confidence < 0 ||
    obj.confidence > 1
  ) {
    throw new GatekeeperResponseError(
      'confidence is missing or out of [0,1]',
      sample,
    );
  }
  if (typeof obj.reason !== 'string') {
    throw new GatekeeperResponseError(
      'reason is missing or not string',
      sample,
    );
  }
  const trimmed = obj.reason.trim();
  if (trimmed.length === 0) {
    throw new GatekeeperResponseError('reason is empty', sample);
  }
  return {
    fit: obj.fit,
    confidence: obj.confidence,
    reason: trimmed.slice(0, 200),
  };
}

const SUBSCORE_KEYS = [
  'core_fit',
  'project_quality',
  'client_signals',
  'budget_rate',
  'strategic_upside',
] as const;
const SUBSCORE_SUM_SLOP = 2;
const parseLogger = new Logger('parseEvaluatorInput');

export function parseEvaluatorInput(
  raw: unknown,
): Omit<EvalResult, 'usage'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvaluatorResponseError(
      'tool input is not an object',
      sanitise(JSON.stringify(raw ?? '')),
    );
  }
  const obj = raw as Record<string, unknown>;
  const sample = sanitise(JSON.stringify(obj));
  const decisionRaw = String(obj.decision ?? '').toLowerCase();
  const priorityRaw = String(obj.priority ?? '').toLowerCase();
  if (!VALID_DECISIONS.includes(decisionRaw as Decision)) {
    throw new EvaluatorResponseError(`invalid decision "${decisionRaw}"`, sample);
  }
  if (!VALID_PRIORITIES.includes(priorityRaw as Priority)) {
    throw new EvaluatorResponseError(`invalid priority "${priorityRaw}"`, sample);
  }
  const scoreRaw = Number(obj.match_score);
  if (!Number.isFinite(scoreRaw)) {
    throw new EvaluatorResponseError(
      `invalid match_score "${String(obj.match_score)}"`,
      sample,
    );
  }
  const matchScore = Math.max(0, Math.min(100, Math.round(scoreRaw)));

  const shortSummary =
    typeof obj.short_summary === 'string' ? obj.short_summary.trim() : '';
  if (!shortSummary) {
    throw new EvaluatorResponseError('short_summary missing or empty', sample);
  }

  const subscores = parseSubscores(obj.subscores);
  if (subscores) {
    const sum =
      (subscores.core_fit ?? 0) +
      (subscores.project_quality ?? 0) +
      (subscores.client_signals ?? 0) +
      (subscores.budget_rate ?? 0) +
      (subscores.strategic_upside ?? 0);
    if (Math.abs(sum - matchScore) > SUBSCORE_SUM_SLOP) {
      // Model is authoritative on `match_score`; the subscore sum
      // mismatch is an audit signal, not a correctness failure.
      parseLogger.warn(
        `Subscore sum ${sum} drifted from match_score ${matchScore} ` +
          `(> ${SUBSCORE_SUM_SLOP}); keeping match_score as reported.`,
      );
    }
  }

  const legacyReasoning =
    typeof obj.reasoning === 'string' ? obj.reasoning.trim() : '';

  return {
    decision: decisionRaw as Decision,
    matchScore,
    priority: priorityRaw as Priority,
    // v2 envelope.
    shortSummary: shortSummary.slice(0, 1200),
    reasons: stringArrayCap(obj.reasons, 6, 240),
    redFlags: stringArrayCap(obj.red_flags, 6, 240),
    hardStop: obj.hard_stop === true,
    hardStopReason: optTrimmedCapped(obj.hard_stop_reason, 240),
    subscores,
    // Legacy (v1) fields — populated only when historical shape leaks
    // through; new prompt will not emit them.
    reasoning: legacyReasoning ? legacyReasoning.slice(0, 800) : null,
    strengths: stringArrayCap(obj.strengths, 3, 160),
    risks: stringArrayCap(obj.risks, 3, 160),
    scopeClarity: optTrimmedCapped(obj.scope_clarity, 240),
    quickWin: optTrimmedCapped(obj.quick_win, 240),
    effortEstimate: optTrimmedCapped(obj.effort_estimate, 120),
    raw: obj,
  };
}

function parseSubscores(raw: unknown): EvalSubscores | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out: EvalSubscores = {};
  let anyPresent = false;
  for (const key of SUBSCORE_KEYS) {
    const v = Number(obj[key]);
    if (Number.isFinite(v)) {
      out[key] = Math.max(0, Math.round(v));
      anyPresent = true;
    }
  }
  return anyPresent ? out : null;
}

function stringArrayCap(
  v: unknown,
  maxLen: number,
  perItemMax: number,
): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .slice(0, maxLen)
    .map((s) => s.trim().slice(0, perItemMax));
}

function optTrimmedCapped(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function extractUsage(
  usage: Anthropic.Usage | undefined,
  model: string,
): AiUsage {
  return {
    model,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

function sanitise(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function normaliseEffort(raw: unknown): 'low' | 'medium' | 'high' {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'medium' || v === 'high') return v;
  return 'low';
}

/**
 * Extracts a structured JSON payload from an Anthropic response.
 * Preference order:
 *   1. the single `tool_use` block for the expected tool name
 *      (the happy path when the model decided to call the tool);
 *   2. a `text` block whose content parses as JSON (fallback for
 *      cases where `tool_choice: auto` left the model free to
 *      emit text — we still get structured output because the
 *      prompt instructed it so).
 * Server-side validation (parseGatekeeperInput /
 * parseEvaluatorInput) runs on both paths — Anthropic has no
 * `strict` mode as of this writing, so forced tool choice is NOT
 * a correctness guarantee.
 */
function extractStructuredPayload(
  response: Anthropic.Message,
  expectedToolName: string,
  err: (reason: string, sample: string) => Error,
): unknown {
  const toolUse = response.content.find(
    (c): c is Anthropic.ToolUseBlock =>
      c.type === 'tool_use' && c.name === expectedToolName,
  );
  if (toolUse) return toolUse.input;

  // Fallback: find a text block that parses as JSON (strip
  // ``` fences if the model added them).
  const textBlocks = response.content.filter(
    (c): c is Anthropic.TextBlock => c.type === 'text',
  );
  for (const block of textBlocks) {
    const cleaned = block.text.replace(/```json/g, '').replace(/```/g, '').trim();
    if (!cleaned) continue;
    try {
      return JSON.parse(cleaned);
    } catch {
      // Try next block.
    }
  }
  throw err(
    'no tool_use or JSON text block in response',
    sanitise(JSON.stringify(response.content ?? '')),
  );
}
