import { describe, expect, it, jest } from '@jest/globals';
import {
  EvaluatorResponseError,
  parseEvaluatorInput,
} from './ai-job-evaluator.service';

const V2_VALID = {
  decision: 'approve',
  match_score: 86,
  priority: 'high',
  hard_stop: false,
  hard_stop_reason: '',
  reasons: ['Great Stripe fit', 'Clean client'],
  red_flags: ['SAP B1 scope creep risk'],
  short_summary: 'Strong fit, apply.',
  subscores: {
    core_fit: 42,
    project_quality: 14,
    client_signals: 14,
    budget_rate: 13,
    strategic_upside: 3,
  },
};

describe('parseEvaluatorInput — v2 envelope', () => {
  it('maps the happy path into EvalResult', () => {
    const r = parseEvaluatorInput(V2_VALID);
    expect(r.decision).toBe('approve');
    expect(r.matchScore).toBe(86);
    expect(r.priority).toBe('high');
    expect(r.shortSummary).toBe('Strong fit, apply.');
    expect(r.reasons).toEqual(['Great Stripe fit', 'Clean client']);
    expect(r.redFlags).toEqual(['SAP B1 scope creep risk']);
    expect(r.hardStop).toBe(false);
    expect(r.hardStopReason).toBeNull();
    expect(r.subscores).toEqual({
      core_fit: 42,
      project_quality: 14,
      client_signals: 14,
      budget_rate: 13,
      strategic_upside: 3,
    });
    expect(r.raw).toBe(V2_VALID);
  });

  it('propagates hard_stop=true + reason', () => {
    const r = parseEvaluatorInput({
      ...V2_VALID,
      hard_stop: true,
      hard_stop_reason: 'Client country in blocklist',
    });
    expect(r.hardStop).toBe(true);
    expect(r.hardStopReason).toBe('Client country in blocklist');
  });

  it('throws when short_summary is missing', () => {
    const { short_summary: _, ...rest } = V2_VALID;
    expect(() => parseEvaluatorInput(rest)).toThrow(EvaluatorResponseError);
  });

  it('throws when short_summary is empty', () => {
    expect(() =>
      parseEvaluatorInput({ ...V2_VALID, short_summary: '   ' }),
    ).toThrow(EvaluatorResponseError);
  });

  it('throws on invalid decision / priority / match_score', () => {
    expect(() =>
      parseEvaluatorInput({ ...V2_VALID, decision: 'maybe-not' }),
    ).toThrow(EvaluatorResponseError);
    expect(() =>
      parseEvaluatorInput({ ...V2_VALID, priority: 'urgent' }),
    ).toThrow(EvaluatorResponseError);
    expect(() =>
      parseEvaluatorInput({ ...V2_VALID, match_score: 'nope' }),
    ).toThrow(EvaluatorResponseError);
  });

  it('clamps match_score into 0..100', () => {
    const over = parseEvaluatorInput({ ...V2_VALID, match_score: 220 });
    expect(over.matchScore).toBe(100);
    const under = parseEvaluatorInput({ ...V2_VALID, match_score: -5 });
    expect(under.matchScore).toBe(0);
  });

  it('warn-logs (does not throw) when subscore sum drifts from match_score', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Sum = 20, declared match_score = 86 → mismatch > slop.
      const r = parseEvaluatorInput({
        ...V2_VALID,
        subscores: {
          core_fit: 5,
          project_quality: 5,
          client_signals: 5,
          budget_rate: 3,
          strategic_upside: 2,
        },
      });
      expect(r.matchScore).toBe(86); // authoritative, kept as-is
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('accepts missing subscores (null) for backward-shape', () => {
    const { subscores: _, ...rest } = V2_VALID;
    const r = parseEvaluatorInput(rest);
    expect(r.subscores).toBeNull();
  });
});

describe('parseEvaluatorInput — legacy (v1) fallthrough', () => {
  it('still parses optional legacy fields when model happens to emit them', () => {
    const r = parseEvaluatorInput({
      ...V2_VALID,
      reasoning: 'Legacy reasoning text',
      strengths: ['Stripe', 'Node'],
      risks: ['scope'],
      scope_clarity: 'Well-defined',
      quick_win: 'Replay webhook',
      effort_estimate: '2-3 weeks',
    });
    expect(r.reasoning).toBe('Legacy reasoning text');
    expect(r.strengths).toEqual(['Stripe', 'Node']);
    expect(r.risks).toEqual(['scope']);
    expect(r.scopeClarity).toBe('Well-defined');
    expect(r.quickWin).toBe('Replay webhook');
    expect(r.effortEstimate).toBe('2-3 weeks');
  });

  it('leaves legacy fields null/empty when absent', () => {
    const r = parseEvaluatorInput(V2_VALID);
    expect(r.reasoning).toBeNull();
    expect(r.strengths).toEqual([]);
    expect(r.risks).toEqual([]);
    expect(r.scopeClarity).toBeNull();
    expect(r.quickWin).toBeNull();
    expect(r.effortEstimate).toBeNull();
  });
});
