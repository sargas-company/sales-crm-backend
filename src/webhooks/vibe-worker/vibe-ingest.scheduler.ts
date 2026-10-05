import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { JobPostQueueService } from '../../job-post/job-post-queue.service';
import { VibeIngestProcessorService } from './vibe-ingest-processor.service';

/**
 * If a tick's work hangs (e.g. a Prisma call stuck on an exhausted
 * connection pool), a boolean in-process guard would permanently
 * silence every subsequent tick with no visible log line. We instead
 * record the start time of the currently-running tick and treat the
 * guard as stale after this many milliseconds, log a WARN with the
 * elapsed time and run the next tick anyway. Two minutes is well
 * above any realistic healthy tick duration and well below the time
 * a human operator needs to notice stuck ingest. The value is a
 * recovery ceiling, not a timeout: it does not interrupt the hung
 * call, only lets a parallel one proceed.
 */
const STALE_GUARD_MS = 2 * 60 * 1000;

/**
 * Scanner Core durability loops.
 *
 *   1. `inboxDrainTick` — picks up every `JobPostIngestEvent(RECEIVED)`
 *      and runs it through `VibeIngestProcessorService`. This replaces
 *      the previous fire-and-forget hot path from the webhook
 *      controller: the HTTP handler now only persists the event and
 *      returns 202; the mapping + JobPost upsert + queue enqueue
 *      happens here. Latency is bounded by the cron interval.
 *
 *   2. `queueReconcileTick` — re-enqueues every `JobPost(status=NEW)`
 *      into the existing `job-post-processing` BullMQ queue. BullMQ
 *      dedup by `jobId=jobPostId` makes this a no-op for rows that
 *      are already queued; the point is to recover from a transient
 *      Redis outage WITHOUT a backend restart. The FIRST tick after
 *      process boot ALSO performs the one-off PROCESSING → NEW
 *      cleanup that used to live in
 *      `JobPostQueueService.onModuleInit` — moving it out of
 *      `onModuleInit` is what lets Nest reach `app.listen()` even
 *      under a non-trivial backlog. The reset is bounded by a
 *      conservative `createdAt` age floor so an already-running
 *      second instance's in-flight rows are not disturbed.
 *
 * Mutual exclusion:
 *
 *   - In-process re-entrancy flag per instance — a tick can never
 *     overlap with itself inside the same Node process.
 *   - Across backend instances mutual exclusion is enforced at the
 *     data layer, not by a scheduler-level DB lock:
 *       - JobPost has `providerJobId @unique`, so even if two
 *         instances convert the same ingest event concurrently they
 *         end up pointing at the one row that already exists;
 *       - BullMQ enqueue uses `jobId=jobPostId`, so concurrent
 *         enqueues from different schedulers converge on a single
 *         queue job.
 *     This keeps the lock story simple (no connection-pool /
 *     advisory-lock surprises) while still giving the single-job
 *     guarantee.
 *
 * On-boot recovery is deferred to the FIRST scheduler tick after
 * startup. No service's `onModuleInit` scans or enqueues rows any
 * more, so bootstrap can reach `app.listen()` regardless of backlog
 * size or Redis latency after Queue construction.
 */
@Injectable()
export class VibeIngestScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(VibeIngestScheduler.name);
  // Timestamps instead of booleans: a stuck tick cannot silently
  // gate every subsequent tick (see STALE_GUARD_MS above).
  private drainingSince: number | null = null;
  private reconcilingSince: number | null = null;
  // Boot-recovery one-shot latch. The first `queueReconcileTick`
  // after process start flips genuinely-stuck PROCESSING rows to
  // NEW; every tick after that only re-enqueues NEW rows. Scoped
  // per Node process — a rolling deploy re-runs recovery once per
  // new instance, which is intentional.
  private firstReconcileDone = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: VibeIngestProcessorService,
    private readonly queue: JobPostQueueService,
  ) {}

  /**
   * Logged exactly once per process when Nest has finished bootstrap
   * (which includes ScheduleModule's cron-registration pass). If
   * this line is missing from production logs, the scheduler module
   * is NOT being discovered and no @Cron is firing — the problem is
   * wiring, not tick-level logic.
   */
  onApplicationBootstrap(): void {
    this.logger.log(
      `VibeIngestScheduler bootstrap — inbox-drain + queue-reconcile every 30s`,
    );
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'vibe-ingest-inbox-drain' })
  async inboxDrainTick(): Promise<void> {
    if (!this.claimGuard('drain')) return;
    this.logger.log('inboxDrainTick started');
    try {
      const n = await this.processor.drainReceived();
      this.logger.log(`inboxDrainTick finished: processed ${n} RECEIVED event(s)`);
    } catch (err) {
      // Full stack preserved — scheduler-level failures were
      // previously only logged as `.message`, which swallowed root
      // causes like Prisma connection-pool exhaustion. Keeping the
      // throw out of here is deliberate: @Cron swallows thrown
      // errors silently and we would then lose both the stack and
      // the next scheduled tick.
      this.logger.error(
        `inboxDrainTick failed: ${(err as Error).stack ?? (err as Error).message}`,
      );
    } finally {
      this.drainingSince = null;
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'vibe-ingest-queue-reconcile' })
  async queueReconcileTick(): Promise<void> {
    if (!this.claimGuard('reconcile')) return;
    this.logger.log('queueReconcileTick started');
    try {
      // One-off boot recovery lives inside the first tick, NOT in
      // JobPostQueueService.onModuleInit, so Nest can reach
      // app.listen() even under a large PROCESSING / NEW backlog.
      // Age-bounded so an already-running second instance's
      // in-flight rows are not disturbed.
      if (!this.firstReconcileDone) {
        try {
          const reset = await this.queue.resetStuckProcessing();
          this.logger.log(
            `queueReconcileTick: first-tick recovery reset ${reset} stuck PROCESSING → NEW`,
          );
          this.firstReconcileDone = true;
        } catch (err) {
          this.logger.error(
            `first-tick resetStuckProcessing failed, will retry: ${(err as Error).stack ?? (err as Error).message}`,
          );
          // Leave the latch down so the next tick retries the reset.
          return;
        }
      }
      const enqueued = await this.reconcileNewJobPosts();
      this.logger.log(`queueReconcileTick finished: enqueued ${enqueued} NEW JobPost(s)`);
    } catch (err) {
      this.logger.error(
        `queueReconcileTick failed: ${(err as Error).stack ?? (err as Error).message}`,
      );
    } finally {
      this.reconcilingSince = null;
    }
  }

  /**
   * Returns true if the caller may proceed with the tick body.
   * Returns false when a previous tick is still running within the
   * STALE_GUARD_MS window. When the previous timestamp is older
   * than the window, we WARN that the earlier tick appears stuck
   * and let the new one through — the guard is a recovery ceiling,
   * not a hard timeout.
   */
  private claimGuard(kind: 'drain' | 'reconcile'): boolean {
    const now = Date.now();
    const sinceField = kind === 'drain' ? 'drainingSince' : 'reconcilingSince';
    const since = this[sinceField];
    if (since) {
      const elapsed = now - since;
      if (elapsed < STALE_GUARD_MS) {
        this.logger.debug(
          `${kind} tick skipped: previous tick still running (${elapsed}ms)`,
        );
        return false;
      }
      this.logger.warn(
        `${kind} tick: previous tick appears stuck (${elapsed}ms) — reclaiming guard and proceeding`,
      );
    }
    this[sinceField] = now;
    return true;
  }

  /**
   * Public entry point so tests (and ops tooling) can drive one
   * reconciliation pass deterministically. BullMQ enqueue is idempotent
   * by `jobId=jobPostId`, so a repeat call for the same JobPost does
   * not create a second queue job.
   */
  async reconcileNewJobPosts(): Promise<number> {
    const rows = await this.prisma.jobPost.findMany({
      where: { status: 'NEW' },
      select: { id: true },
      take: 500,
    });
    this.logger.log(`reconcileNewJobPosts: found ${rows.length} NEW JobPost(s)`);
    let enqueued = 0;
    for (const row of rows) {
      try {
        await this.queue.enqueue(row.id);
        enqueued += 1;
      } catch (err) {
        // Row-level failure (Redis still down) — leave the row NEW
        // so the next tick retries.
        this.logger.warn(
          `enqueue(${row.id}) failed, will retry next tick: ${(err as Error).message}`,
        );
      }
    }
    return enqueued;
  }
}
