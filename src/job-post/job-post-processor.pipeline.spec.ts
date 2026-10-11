/**
 * Pipeline-level regression for the gatekeeper + evaluator integration
 * in JobPostProcessorService. Live Postgres + stub AI evaluator + stub
 * notification service.
 *
 * Phase B: gatekeeper response is `{ fit, confidence, reason, usage }`,
 * evaluator response is the full structured verdict. Reject at the
 * gate ONLY when `fit=false AND confidence >= GATE_REJECT_THRESHOLD`.
 */
import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { JobPostProcessorService } from './job-post-processor.service';
import type {
  AiJobEvaluatorService,
  AiUsage,
  EvalResult,
  GateResult,
} from './ai-job-evaluator.service';
import type { NotificationService } from '../notification/notification.service';
import type { SettingsService } from '../settings/settings.service';
import type { PrismaService } from '../prisma/prisma.service';

const prisma = new PrismaClient();
const TAG = `gatekeeper-${randomUUID().slice(0, 8)}`;
const createdJobPostIds: string[] = [];

const FAKE_USAGE: AiUsage = {
  model: 'test-model',
  inputTokens: 42,
  outputTokens: 7,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

afterEach(async () => {
  if (createdJobPostIds.length) {
    await prisma.jobPost.deleteMany({ where: { id: { in: createdJobPostIds } } });
    createdJobPostIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedJobPost(providerIdSuffix: string, rawText: string) {
  const jp = await prisma.jobPost.create({
    data: {
      providerJobId: `${TAG}_${providerIdSuffix}_${Date.now()}_${Math.random()}`,
      rawText,
      rawPayload: { smoke: true } as never,
      status: 'NEW',
      scanner: 'vibe-worker',
      hSkillsKeywords: [],
      title: `title ${providerIdSuffix}`,
      jobUrl: 'https://example.com',
    },
    select: { id: true },
  });
  createdJobPostIds.push(jp.id);
  return jp.id;
}

function gateResult(
  fit: boolean,
  confidence: number,
  reason: string,
): GateResult {
  return { fit, confidence, reason, usage: FAKE_USAGE };
}

function evalResult(opts: {
  decision: 'approve' | 'maybe' | 'decline';
  matchScore: number;
  priority: 'high' | 'medium' | 'low';
  reasoning?: string;
}): EvalResult {
  return {
    decision: opts.decision,
    matchScore: opts.matchScore,
    priority: opts.priority,
    reasoning: opts.reasoning ?? 'ok',
    strengths: [],
    risks: [],
    scopeClarity: null,
    quickWin: null,
    effortEstimate: null,
    raw: {},
    usage: FAKE_USAGE,
  };
}

function makeEvaluator(opts: {
  gate: GateResult | Error;
  evaluate?: EvalResult | Error;
}) {
  const gate = jest.fn(async () => {
    if (opts.gate instanceof Error) throw opts.gate;
    return opts.gate;
  });
  const evaluate = jest.fn(async () => {
    if (!opts.evaluate) {
      throw new Error('evaluate should not have been called in this test');
    }
    if (opts.evaluate instanceof Error) throw opts.evaluate;
    return opts.evaluate;
  });
  return { gate, evaluate } as unknown as AiJobEvaluatorService & {
    gate: jest.Mock;
    evaluate: jest.Mock;
  };
}

function makeNotifier() {
  const createEvent = jest.fn(async () => undefined);
  return { createEvent } as unknown as NotificationService & { createEvent: jest.Mock };
}

function makeSettings(enabled = true): SettingsService {
  return {
    getBooleanForKey: async (_k: string, _d: boolean) => enabled,
  } as unknown as SettingsService;
}

function buildProcessor(
  evaluator: ReturnType<typeof makeEvaluator>,
  notifier: ReturnType<typeof makeNotifier>,
  settings: SettingsService = makeSettings(true),
) {
  const svc = new JobPostProcessorService(
    prisma as unknown as PrismaService,
    { get: () => undefined } as never,
    evaluator,
    notifier,
    settings,
  );
  return svc;
}

describe('JobPostProcessorService — gatekeeper high-confidence reject', () => {
  it('Webflow / high-confidence false → PROCESSED decline, evaluate not called', async () => {
    const id = await seedJobPost(
      'webflow',
      'We need a Webflow-only landing page build with no dev.',
    );
    const evaluator = makeEvaluator({
      gate: gateResult(false, 0.95, 'Webflow-only build'),
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.status).toBe('PROCESSED');
    expect(jp.decision).toBe('decline');
    expect(jp.matchScore).toBe(0);
    expect(jp.priority).toBe('low');
    expect(jp.processedAt).not.toBeNull();
    const ai = jp.aiResponse as {
      gatekeeper?: { fit?: boolean; confidence?: number; reason?: string };
    };
    expect(ai.gatekeeper?.fit).toBe(false);
    expect(ai.gatekeeper?.confidence).toBe(0.95);
    expect(ai.gatekeeper?.reason).toBe('Webflow-only build');

    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(notifier.createEvent).not.toHaveBeenCalled();
  });

  it('low-confidence false → still proceeds to Sonnet (does NOT reject at gate)', async () => {
    const id = await seedJobPost(
      'borderline',
      'Node project, requirements vague — gatekeeper not sure.',
    );
    const evaluator = makeEvaluator({
      gate: gateResult(false, 0.6, 'uncertain fit'),
      evaluate: evalResult({
        decision: 'maybe',
        matchScore: 55,
        priority: 'medium',
      }),
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.decision).toBe('maybe');
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    expect(notifier.createEvent).toHaveBeenCalledTimes(1);
  });

  it('fit=true (regardless of confidence) → evaluate runs', async () => {
    const id = await seedJobPost(
      'fit-high',
      'Need a Node.js dev to extend our Stripe integration with marketplace fees.',
    );
    const evaluator = makeEvaluator({
      gate: gateResult(true, 0.9, 'pass: Node + Stripe'),
      evaluate: evalResult({
        decision: 'approve',
        matchScore: 85,
        priority: 'high',
      }),
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.status).toBe('PROCESSED');
    expect(jp.decision).toBe('approve');
    expect(jp.matchScore).toBe(85);
    const ai = jp.aiResponse as {
      gatekeeper?: { fit?: boolean };
      evaluation?: { reasoning?: string };
    };
    expect(ai.gatekeeper?.fit).toBe(true);
    expect(ai.evaluation?.reasoning).toBe('ok');
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    expect(notifier.createEvent).toHaveBeenCalledTimes(1);
  });

  it('writes analysisModelVersion from evaluator usage.model', async () => {
    const id = await seedJobPost(
      'model-version',
      'Node project, pass through to evaluator.',
    );
    const evaluator = makeEvaluator({
      gate: gateResult(true, 0.9, 'pass'),
      evaluate: evalResult({
        decision: 'approve',
        matchScore: 70,
        priority: 'medium',
      }),
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);
    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });
    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.analysisModelVersion).toBe('test-model');
    expect(jp.lastAnalysisAt).not.toBeNull();
    expect(jp.enqueueState).toBeNull();
  });
});

describe('JobPostProcessorService — error paths', () => {
  it('gatekeeper transient throw → status rolled back to NEW on non-last attempt', async () => {
    const id = await seedJobPost(
      'gate-boom',
      'Node project; backend will crash the gatekeeper call.',
    );
    const evaluator = makeEvaluator({ gate: new Error('Anthropic 500') });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await expect(
      svc.processJobPost(id, { attempt: 0, maxAttempts: 3 }),
    ).rejects.toThrow('Anthropic 500');

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.status).toBe('NEW');
    expect(jp.enqueueState).toBe('PENDING');
    expect(jp.decision).toBeNull();
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(notifier.createEvent).not.toHaveBeenCalled();
  });

  it('gatekeeper throws on LAST attempt → FAILED', async () => {
    const id = await seedJobPost(
      'gate-boom-last',
      'Node project; final attempt gatekeeper crash.',
    );
    const evaluator = makeEvaluator({ gate: new Error('Anthropic 500 again') });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await expect(
      svc.processJobPost(id, { attempt: 2, maxAttempts: 3 }),
    ).rejects.toThrow('Anthropic 500');

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.status).toBe('FAILED');
    expect(jp.enqueueState).toBeNull();
  });

  it('permanent GatekeeperResponseError goes straight to FAILED on FIRST attempt', async () => {
    const id = await seedJobPost(
      'gate-perm',
      'Node project; model returns invalid gate payload.',
    );
    // Import at use site to avoid a circular import issue if there is one.
    const { GatekeeperResponseError } = await import('./ai-job-evaluator.service');
    const evaluator = makeEvaluator({
      gate: new GatekeeperResponseError('fit missing', '{}'),
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await expect(
      svc.processJobPost(id, { attempt: 0, maxAttempts: 3 }),
    ).rejects.toThrow(/Gatekeeper response invalid/);

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.status).toBe('FAILED');
    expect(jp.lastAnalysisError).toContain('Gatekeeper response invalid');
  });
});

describe('JobPostProcessorService — kill-switch and dedup', () => {
  it('scanner.analysisEnabled=false leaves JobPost NEW, no AI call', async () => {
    const id = await seedJobPost(
      'paused',
      'React project — but scanner is paused by the operator.',
    );
    const evaluator = makeEvaluator({
      gate: gateResult(true, 0.9, 'should not be called'),
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier, makeSettings(false));

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.status).toBe('NEW');
    expect(evaluator.gate).not.toHaveBeenCalled();
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(notifier.createEvent).not.toHaveBeenCalled();
  });

  it('a JobPost that is already PROCESSING is never analysed twice', async () => {
    const seed = await prisma.jobPost.create({
      data: {
        providerJobId: `${TAG}_dedup_${Date.now()}`,
        rawText: 'x',
        rawPayload: {} as never,
        status: 'PROCESSING',
        scanner: 'vibe-worker',
        hSkillsKeywords: [],
      },
      select: { id: true },
    });
    createdJobPostIds.push(seed.id);

    const evaluator = makeEvaluator({
      gate: gateResult(true, 0.9, 'should not be called'),
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);
    await svc.processJobPost(seed.id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id: seed.id } });
    expect(jp.status).toBe('PROCESSING');
    expect(evaluator.gate).not.toHaveBeenCalled();
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(notifier.createEvent).not.toHaveBeenCalled();
  });
});
