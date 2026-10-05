/**
 * Pipeline-level regression for the gatekeeper integration in
 * JobPostProcessorService. Live Postgres + stub AI evaluator + stub
 * notification service — same pattern as the other integration specs.
 *
 * We drive `processJobPost(jobPostId, {attempt, maxAttempts})` directly
 * (public method lifted out of the BullMQ shim) so the test exercises
 * the real DB side-effects without needing Redis.
 */
import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { JobPostProcessorService } from './job-post-processor.service';
import type { AiJobEvaluatorService, GateResult } from './ai-job-evaluator.service';
import type { NotificationService } from '../notification/notification.service';
import type { SettingsService } from '../settings/settings.service';
import type { PrismaService } from '../prisma/prisma.service';

const prisma = new PrismaClient();
const TAG = `gatekeeper-${randomUUID().slice(0, 8)}`;
const createdJobPostIds: string[] = [];

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

function makeEvaluator(opts: {
  gate: GateResult | Error;
  evaluate?:
    | {
        decision: 'approve' | 'maybe' | 'decline';
        matchScore: number;
        priority: 'high' | 'medium' | 'low';
        aiResponse: object;
      }
    | Error;
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
  // Skip the BullMQ worker wiring entirely — tests drive processJobPost
  // directly.
  const svc = new JobPostProcessorService(
    prisma as unknown as PrismaService,
    { get: () => undefined } as never,
    evaluator,
    notifier,
    settings,
  );
  return svc;
}

describe('JobPostProcessorService — gatekeeper reject path', () => {
  it('Webflow / Shopify / WordPress reject → PROCESSED decline, evaluate not called, no notification', async () => {
    const id = await seedJobPost(
      'webflow',
      'We need a Webflow-only landing page build with no dev.',
    );
    const evaluator = makeEvaluator({ gate: { fit: false, reason: 'Webflow-only build' } });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.status).toBe('PROCESSED');
    expect(jp.decision).toBe('decline');
    expect(jp.matchScore).toBe(0);
    expect(jp.priority).toBe('low');
    expect(jp.processedAt).not.toBeNull();
    expect(jp.aiResponse).toEqual({
      gatekeeper: { fit: false, reason: 'Webflow-only build' },
    });

    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(notifier.createEvent).not.toHaveBeenCalled();
  });

  it('hourly < $30 rejected by gatekeeper → decline, evaluate not called', async () => {
    const id = await seedJobPost(
      'cheap-hourly',
      'Hourly rate 20 USD/hr, long term Node project.',
    );
    const evaluator = makeEvaluator({
      gate: { fit: false, reason: 'rate below 30/hr: 20' },
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.decision).toBe('decline');
    expect((jp.aiResponse as { gatekeeper?: { reason?: string } }).gatekeeper?.reason).toContain(
      'rate below 30',
    );
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(notifier.createEvent).not.toHaveBeenCalled();
  });

  it('fixed budget < $1000 rejected → decline, evaluate not called', async () => {
    const id = await seedJobPost('cheap-fixed', 'Fixed budget 500 USD for a small build.');
    const evaluator = makeEvaluator({
      gate: { fit: false, reason: 'fixed budget 500 USD < 1000' },
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.decision).toBe('decline');
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(notifier.createEvent).not.toHaveBeenCalled();
  });

  it('location-only reject (e.g. US residents only) → decline, evaluate not called', async () => {
    const id = await seedJobPost(
      'location',
      'US-based residents only; strict citizenship requirement.',
    );
    const evaluator = makeEvaluator({
      gate: { fit: false, reason: 'US residents only — excludes our team' },
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.decision).toBe('decline');
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(notifier.createEvent).not.toHaveBeenCalled();
  });
});

describe('JobPostProcessorService — gatekeeper pass path', () => {
  it('Node + Stripe passes → evaluate runs, PROCESSED approve, notification created', async () => {
    const id = await seedJobPost(
      'node-stripe',
      'Need a Node.js dev to extend our Stripe integration with marketplace fees.',
    );
    const evaluator = makeEvaluator({
      gate: { fit: true, reason: 'pass: Node + Stripe' },
      evaluate: {
        decision: 'approve',
        matchScore: 85,
        priority: 'high',
        aiResponse: { category: 'saas-integration' },
      },
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.status).toBe('PROCESSED');
    expect(jp.decision).toBe('approve');
    expect(jp.matchScore).toBe(85);
    expect(jp.priority).toBe('high');
    expect(jp.aiResponse).toEqual({
      gatekeeper: { fit: true, reason: 'pass: Node + Stripe' },
      evaluation: { category: 'saas-integration' },
    });

    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    expect(notifier.createEvent).toHaveBeenCalledTimes(1);
  });

  it('budget missing is NOT a reject — gatekeeper lets it pass, evaluate runs', async () => {
    const id = await seedJobPost(
      'budget-missing',
      'React + NestJS SaaS — budget TBD, let us talk.',
    );
    const evaluator = makeEvaluator({
      gate: { fit: true, reason: 'budget missing but core fit; defer to evaluator' },
      evaluate: {
        decision: 'maybe',
        matchScore: 55,
        priority: 'medium',
        aiResponse: { note: 'low signal' },
      },
    });
    const notifier = makeNotifier();
    const svc = buildProcessor(evaluator, notifier);

    await svc.processJobPost(id, { attempt: 0, maxAttempts: 3 });

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(jp.decision).toBe('maybe');
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
    expect(notifier.createEvent).toHaveBeenCalledTimes(1);
  });
});

describe('JobPostProcessorService — error paths', () => {
  it('gatekeeper throws → status rolled back to NEW on non-last attempt (retry path, no FAILED mask)', async () => {
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
    expect(jp.decision).toBeNull();
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(notifier.createEvent).not.toHaveBeenCalled();
  });

  it('gatekeeper throws on LAST attempt → FAILED (existing retry contract)', async () => {
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
  });
});

describe('JobPostProcessorService — kill-switch and dedup', () => {
  it('scanner.analysisEnabled=false leaves JobPost NEW, no AI call', async () => {
    const id = await seedJobPost(
      'paused',
      'React project — but scanner is paused by the operator.',
    );
    const evaluator = makeEvaluator({
      gate: { fit: true, reason: 'should not be called' },
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
    // Pre-flip to PROCESSING to simulate a sibling worker that already
    // took the row. updateMany({ where: status:'NEW' }) returns 0 and
    // the processor returns without calling the AI.
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
      gate: { fit: true, reason: 'should not be called' },
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
