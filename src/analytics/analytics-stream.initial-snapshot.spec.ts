/**
 * Spec for AnalyticsStreamController's "fresh snapshot on every
 * subscribe" contract.
 *
 * Two SSE clients must each receive an immediate `tick` frame
 * computed from CURRENT state — not a cached value from before
 * their connect / reconnect — and the pipeline must deduplicate
 * live-event bursts so a flood of events doesn't translate into a
 * flood of DB round-trips.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { Subject } from 'rxjs';
import { firstValueFrom, take, timeout } from 'rxjs';
import type { Request } from 'express';

import { AnalyticsStreamController } from './analytics-stream.controller';
import type { LiveEventsService } from '../live-events/live-events.service';
import type { JobPostService } from '../job-post/job-post.service';
import type { AnalyticsService } from './analytics.service';
import type { AiSpendService } from './ai-spend.service';

const makeReq = (query: Record<string, string> = {}): Request =>
  ({ query }) as unknown as Request;

function makeStubs(opts: { lastEventAt?: string | null } = {}) {
  const subject = new Subject<unknown>();
  const liveEvents = {
    stream$: () => subject.asObservable(),
  } as unknown as LiveEventsService;
  const getQueueStats = jest.fn<() => Promise<unknown>>().mockResolvedValue({
    analysisEnabled: true,
    totalNew: 0,
    backlog: 0,
    pending: 0,
    failed: 0,
    inQueue: 0,
    running: 0,
    redisAvailable: true,
    queueWaiting: 0,
    queueDelayed: 0,
    queueActive: 0,
    queuePaused: 0,
    queuePrioritized: 0,
    lastUpdated: new Date().toISOString(),
  } as never);
  const getScannerHealth = jest.fn<() => Promise<unknown>>().mockResolvedValue({
    status: 'running',
    endpoint: '/x',
    timezone: 'Europe/Kyiv',
    lastEventAt: opts.lastEventAt ?? null,
    lastAnalyzedAt: null,
    receivedLastHour: 0,
    receivedToday: 0,
    analyzedToday: 0,
    analyzedOfTodaysReceived: 0,
    processingRatePerHour: 0,
    medianProcessingLatencyMs: null,
    dataFreshnessSeconds: null,
    webhookErrors: 0,
    analyzerErrors: 0,
    discordDeliveryErrors: 0,
    duplicates: 0,
    period: 'today',
    receivedInPeriod: 0,
    analyzedInPeriod: 0,
    discordAlertsInPeriod: 0,
    duplicatesInPeriod: 0,
    errorsInPeriod: 0,
  } as never);
  const getSalesOverview = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({
      received: { current: 0, previous: 0, trendPct: null, confidence: 'low' },
      qualified: { current: 0, previous: 0, trendPct: null, confidence: 'low' },
      hot: { current: 0, previous: 0, trendPct: null, confidence: 'low' },
      qualifiedRate: { current: 0, previous: 0, trendPct: null, confidence: 'low' },
      averageScore: { current: 0, previous: 0, trendPct: null, confidence: 'low' },
    } as never);
  const getAiSpend = jest.fn<() => Promise<unknown>>().mockResolvedValue({
    window: { from: '', to: '', label: 'Today' },
    totalUsd: 0,
    totalCalls: 0,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    perModel: [],
    perOperation: [],
    perDay: [],
    pricingVersion: '2026-01',
  } as never);
  const jobPosts = { getQueueStats } as unknown as JobPostService;
  const analytics = { getScannerHealth, getSalesOverview } as unknown as AnalyticsService;
  const aiSpend = { getAiSpend } as unknown as AiSpendService;
  return {
    liveEvents,
    jobPosts,
    analytics,
    aiSpend,
    subject,
    getQueueStats,
    getScannerHealth,
    getSalesOverview,
    getAiSpend,
  };
}

describe('AnalyticsStreamController — initial snapshot contract', () => {
  it('a new subscriber gets a snapshot tick without waiting for a live event', async () => {
    const {
      liveEvents,
      jobPosts,
      analytics,
      aiSpend,
      getQueueStats,
      getScannerHealth,
      getSalesOverview,
      getAiSpend,
    } = makeStubs();
    const ctrl = new AnalyticsStreamController(
      liveEvents,
      jobPosts,
      analytics,
      aiSpend,
    );
    const first = await firstValueFrom(
      ctrl.stream(makeReq()).pipe(take(1), timeout(2000)),
    );
    expect(first.type).toBe('tick');
    const data = first.data as {
      queueStats: unknown;
      scanner: unknown;
      salesOverview: unknown;
      aiSpend: unknown;
    };
    expect(data.queueStats).toBeDefined();
    expect(data.scanner).toBeDefined();
    expect(data.salesOverview).toBeDefined();
    expect(data.aiSpend).toBeDefined();
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(getScannerHealth).toHaveBeenCalledTimes(1);
    expect(getSalesOverview).toHaveBeenCalledTimes(1);
    expect(getAiSpend).toHaveBeenCalledTimes(1);
  });

  it('every reconnect produces a fresh snapshot (second subscription re-reads DB, does not reuse the first cache)', async () => {
    const {
      liveEvents,
      jobPosts,
      analytics,
      aiSpend,
      getQueueStats,
      getScannerHealth,
      getSalesOverview,
      getAiSpend,
    } = makeStubs();
    const ctrl = new AnalyticsStreamController(
      liveEvents,
      jobPosts,
      analytics,
      aiSpend,
    );
    await firstValueFrom(ctrl.stream(makeReq()).pipe(take(1), timeout(2000)));
    // Rotate the stub so we can prove the second call re-reads.
    (getScannerHealth as jest.Mock).mockResolvedValueOnce({
      status: 'running',
      endpoint: '/x',
      timezone: 'Europe/Kyiv',
      lastEventAt: '2026-10-11T15:00:00Z',
      lastAnalyzedAt: null,
      receivedLastHour: 5,
      receivedToday: 5,
      analyzedToday: 3,
      analyzedOfTodaysReceived: 3,
      processingRatePerHour: 0,
      medianProcessingLatencyMs: null,
      dataFreshnessSeconds: null,
      webhookErrors: 0,
      analyzerErrors: 0,
      discordDeliveryErrors: 0,
      duplicates: 0,
      period: 'today',
      receivedInPeriod: 5,
      analyzedInPeriod: 3,
      discordAlertsInPeriod: 0,
      duplicatesInPeriod: 0,
      errorsInPeriod: 0,
    } as never);
    const second = await firstValueFrom(
      ctrl.stream(makeReq()).pipe(take(1), timeout(2000)),
    );
    expect(second.type).toBe('tick');
    const scanner = (second.data as { scanner: { receivedLastHour: number } })
      .scanner;
    expect(scanner.receivedLastHour).toBe(5);
    // Each subscription triggered its own snapshot build — four calls per
    // subscription (queueStats + scanner + salesOverview + aiSpend) ×
    // two subscriptions.
    expect(getQueueStats).toHaveBeenCalledTimes(2);
    expect(getScannerHealth).toHaveBeenCalledTimes(2);
    expect(getSalesOverview).toHaveBeenCalledTimes(2);
    expect(getAiSpend).toHaveBeenCalledTimes(2);
  });

  it('passes query-string filters through to getSalesOverview + getAiSpend', async () => {
    const {
      liveEvents,
      jobPosts,
      analytics,
      aiSpend,
      getSalesOverview,
      getAiSpend,
    } = makeStubs();
    const ctrl = new AnalyticsStreamController(
      liveEvents,
      jobPosts,
      analytics,
      aiSpend,
    );
    await firstValueFrom(
      ctrl
        .stream(makeReq({ dateRange: '30d', timezone: 'Europe/Kyiv' }))
        .pipe(take(1), timeout(2000)),
    );
    expect(getSalesOverview).toHaveBeenCalledWith(
      expect.objectContaining({ dateRange: '30d', timezone: 'Europe/Kyiv' }),
    );
    expect(getAiSpend).toHaveBeenCalledWith(
      expect.objectContaining({ dateRange: '30d', timezone: 'Europe/Kyiv' }),
    );
  });
});
