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

import { AnalyticsStreamController } from './analytics-stream.controller';
import type { LiveEventsService } from '../live-events/live-events.service';
import type { JobPostService } from '../job-post/job-post.service';
import type { AnalyticsService } from './analytics.service';

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
  const jobPosts = { getQueueStats } as unknown as JobPostService;
  const analytics = { getScannerHealth } as unknown as AnalyticsService;
  return { liveEvents, jobPosts, analytics, subject, getQueueStats, getScannerHealth };
}

describe('AnalyticsStreamController — initial snapshot contract', () => {
  it('a new subscriber gets a snapshot tick without waiting for a live event', async () => {
    const { liveEvents, jobPosts, analytics, getQueueStats, getScannerHealth } = makeStubs();
    const ctrl = new AnalyticsStreamController(liveEvents, jobPosts, analytics);
    const first = await firstValueFrom(
      ctrl.stream().pipe(take(1), timeout(2000)),
    );
    expect(first.type).toBe('tick');
    expect((first.data as { queueStats: unknown }).queueStats).toBeDefined();
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(getScannerHealth).toHaveBeenCalledTimes(1);
  });

  it('every reconnect produces a fresh snapshot (second subscription re-reads DB, does not reuse the first cache)', async () => {
    const { liveEvents, jobPosts, analytics, getQueueStats, getScannerHealth } = makeStubs();
    const ctrl = new AnalyticsStreamController(liveEvents, jobPosts, analytics);
    await firstValueFrom(ctrl.stream().pipe(take(1), timeout(2000)));
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
      ctrl.stream().pipe(take(1), timeout(2000)),
    );
    expect(second.type).toBe('tick');
    const scanner = (second.data as { scanner: { receivedLastHour: number } })
      .scanner;
    expect(scanner.receivedLastHour).toBe(5);
    // Each subscription triggered its own snapshot build — two calls total.
    expect(getQueueStats).toHaveBeenCalledTimes(2);
    expect(getScannerHealth).toHaveBeenCalledTimes(2);
  });
});
