/**
 * Pure request-shape spec for AiJobEvaluatorService.
 *
 * The assertions check the DOCUMENTED Anthropic Messages API
 * contract per the Claude 5.5 migration guides:
 *   • https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
 *   • https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
 *   • https://platform.claude.com/docs/en/api/messages
 *   • https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *
 * The two models have DIFFERENT accepted thinking shapes, so the
 * two request builders assert their own allowed shapes
 * independently — a Sonnet-only field must never appear on a Haiku
 * body, and legacy `{disabled}` / `{enabled, budget_tokens}` must
 * appear on NEITHER.
 */
import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import {
  AiJobEvaluatorService,
  EVALUATOR_TOOL,
  GATEKEEPER_TOOL,
} from './ai-job-evaluator.service';

const DOCUMENTED_MESSAGE_FIELDS = new Set([
  'model',
  'max_tokens',
  'system',
  'messages',
  'tools',
  'tool_choice',
  'thinking',
  'output_config',
  'stop_sequences',
  'metadata',
  'service_tier',
  'top_k',
  'top_p',
  'stream',
  'anthropic_version',
  'container',
  'mcp_servers',
  'temperature',
]);

function build(configOverride: Record<string, unknown> = {}) {
  const config = {
    get: (k: string, def?: unknown) =>
      k in configOverride ? configOverride[k] : def,
  } as unknown as ConfigService;
  return new AiJobEvaluatorService(
    { getGatekeeperPrompt: async () => 'x', getEvaluationPrompt: async () => 'x' } as never,
    { client: {} } as never,
    config,
    { record: async () => undefined } as never,
  );
}

type RequestBody = ReturnType<AiJobEvaluatorService['buildGateRequest']>;
function fieldSet(body: RequestBody): Set<string> {
  return new Set(Object.keys(body as unknown as Record<string, unknown>));
}

describe('AI request shape — contract', () => {
  it('neither stage sends sampling knobs incompatible with Claude 5.5 structured output', () => {
    const svc = build();
    const gate = svc.buildGateRequest('SYSTEM', 'USER', 'claude-haiku-5-5');
    const eval_ = svc.buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    for (const body of [gate, eval_]) {
      const b = body as unknown as Record<string, unknown>;
      expect(b.temperature).toBeUndefined();
      expect(b.top_k).toBeUndefined();
      expect(b.top_p).toBeUndefined();
    }
  });

  it('every field on either stage body is a documented Messages API parameter', () => {
    const svc = build();
    const gate = svc.buildGateRequest('SYSTEM', 'USER', 'claude-haiku-5-5');
    const eval_ = svc.buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    for (const field of fieldSet(gate)) {
      expect(DOCUMENTED_MESSAGE_FIELDS.has(field)).toBe(true);
    }
    for (const field of fieldSet(eval_)) {
      expect(DOCUMENTED_MESSAGE_FIELDS.has(field)).toBe(true);
    }
  });
});

describe('AI request shape — Haiku 5.5 (gatekeeper)', () => {
  const svc = build();
  const body = svc.buildGateRequest('SYSTEM', 'USER', 'claude-haiku-5-5');

  it('declares one gatekeeper tool and FORCES tool_choice to that tool (the Haiku 5.5 no-thinking path)', () => {
    expect(body.tools).toHaveLength(1);
    expect((body.tools as unknown as { name: string }[])[0].name).toBe(
      GATEKEEPER_TOOL.name,
    );
    // Forced tool_choice is REQUIRED to suppress Haiku 5.5's
    // default `adaptive` thinking on tool-use trajectories; the
    // response then starts with the tool_use block directly.
    expect(body.tool_choice).toEqual({ type: 'tool', name: GATEKEEPER_TOOL.name });
  });

  it('tool name in tool_choice matches a tool actually declared in the request', () => {
    const chosen = (body.tool_choice as unknown as { type: string; name?: string }).name;
    const declared = (body.tools as unknown as { name: string }[]).map((t) => t.name);
    expect(declared).toContain(chosen);
  });

  it('marks the system prompt with ephemeral cache_control at 1h TTL', () => {
    const sys = body.system as unknown as Array<{
      type: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(sys[0].type).toBe('text');
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('omits the `thinking` field — Haiku 5.5 relies on forced tool_choice to skip thinking, not on an explicit disable', () => {
    expect((body as unknown as Record<string, unknown>).thinking).toBeUndefined();
    expect((body as unknown as Record<string, unknown>).output_config).toBeUndefined();
  });

  it('allocates ≥ 256 output tokens for the structured gate response', () => {
    expect(body.max_tokens).toBeGreaterThanOrEqual(256);
  });

  it('never surfaces the legacy Claude 4.x `{enabled, budget_tokens}` thinking shape even when a legacy env is set', () => {
    const svcWithBudget = build({ CLAUDE_THINKING_GATE_BUDGET: '1024' });
    const body2 = svcWithBudget.buildGateRequest('SYSTEM', 'USER', 'claude-haiku-5-5');
    const thinking = (body2 as unknown as { thinking?: unknown }).thinking;
    expect(thinking).toBeUndefined();
  });
});

describe('AI request shape — Sonnet 5.5 (evaluator)', () => {
  it('declares one evaluator tool and leaves tool_choice at `auto`', () => {
    const body = build().buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    expect(body.tools).toHaveLength(1);
    expect((body.tools as unknown as { name: string }[])[0].name).toBe(
      EVALUATOR_TOOL.name,
    );
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('marks the system prompt with ephemeral cache_control at 1h TTL', () => {
    const body = build().buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    const sys = body.system as unknown as Array<{
      type: string;
      cache_control?: { type: string; ttl?: string };
    }>;
    expect(sys[0].type).toBe('text');
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('never sends `thinking: {type:"disabled"}` — Sonnet 5.5 rejects it with 400', () => {
    const body = build().buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    const thinking = (body as unknown as { thinking?: { type?: string } }).thinking;
    expect(thinking?.type).not.toBe('disabled');
  });

  it('never sends `thinking: {type:"enabled", budget_tokens:N}` — Sonnet 5.5 rejects it with 400', () => {
    const body = build().buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    const thinking = (body as unknown as {
      thinking?: { type?: string; budget_tokens?: unknown };
    }).thinking;
    expect(thinking?.type).not.toBe('enabled');
    expect(thinking?.budget_tokens).toBeUndefined();
  });

  it('places `thinking` and `output_config` as top-level fields (not nested inside thinking)', () => {
    const body = build().buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    const b = body as unknown as Record<string, unknown>;
    // Both fields at the top level of the Messages request.
    expect(b.thinking).toBeDefined();
    expect(b.output_config).toBeDefined();
    // `effort` must NOT appear inside thinking; `output_config`
    // must NOT appear inside thinking.
    const thinking = b.thinking as Record<string, unknown>;
    expect(thinking.effort).toBeUndefined();
    expect(thinking.output_config).toBeUndefined();
    // thinking has ONLY the `type` field.
    expect(Object.keys(thinking).sort()).toEqual(['type']);
  });

  it('default: thinking.type=between_tools, output_config.effort=low', () => {
    const body = build().buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    const b = body as unknown as Record<string, unknown>;
    expect(b.thinking).toEqual({ type: 'between_tools' });
    expect(b.output_config).toEqual({ effort: 'low' });
  });

  it('env `CLAUDE_SONNET_THINKING=between_tools:medium` keeps mode and switches effort at the top level', () => {
    const svc = build({ CLAUDE_SONNET_THINKING: 'between_tools:medium' });
    const body = svc.buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    const b = body as unknown as Record<string, unknown>;
    expect(b.thinking).toEqual({ type: 'between_tools' });
    expect(b.output_config).toEqual({ effort: 'medium' });
  });

  it('env `CLAUDE_SONNET_THINKING=adaptive:high` switches to adaptive, keeping output_config top-level', () => {
    const svc = build({ CLAUDE_SONNET_THINKING: 'adaptive:high' });
    const body = svc.buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    const b = body as unknown as Record<string, unknown>;
    expect(b.thinking).toEqual({ type: 'adaptive' });
    expect(b.output_config).toEqual({ effort: 'high' });
    // Still nothing nested inside thinking.
    expect(Object.keys(b.thinking as Record<string, unknown>).sort()).toEqual(['type']);
  });

  it('invalid env value falls back to the default (between_tools:low), never a 400-triggering shape', () => {
    const svc = build({ CLAUDE_SONNET_THINKING: 'nonsense:bogus' });
    const body = svc.buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    const b = body as unknown as Record<string, unknown>;
    expect(b.thinking).toEqual({ type: 'between_tools' });
    expect(b.output_config).toEqual({ effort: 'low' });
  });

  it('allocates ≥ 1024 output tokens for the structured eval response', () => {
    const body = build().buildEvalRequest('SYSTEM', 'USER', 'claude-sonnet-5-5');
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
  });
});
