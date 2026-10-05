import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { JobPostQueueService } from '../../job-post/job-post-queue.service';
import { VibeIngestProcessorService } from './vibe-ingest-processor.service';

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
export class VibeIngestScheduler {
  private readonly logger = new Logger(VibeIngestScheduler.name);
  private draining = false;
  private reconciling = false;
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

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'vibe-ingest-inbox-drain' })
  async inboxDrainTick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.processor.drainReceived();
    } catch (err) {
      this.logger.warn(
        `inboxDrainTick failed: ${(err as Error).message} — events stay RECEIVED and will be retried on next tick`,
      );
    } finally {
      this.draining = false;
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'vibe-ingest-queue-reconcile' })
  async queueReconcileTick(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      // One-off boot recovery lives inside the first tick, NOT in
      // JobPostQueueService.onModuleInit, so Nest can reach
      // app.listen() even when there is a large PROCESSING / NEW
      // backlog. Age-bounded so another live instance's in-flight
      // rows are left alone.
      if (!this.firstReconcileDone) {
        try {
          await this.queue.resetStuckProcessing();
        } catch (err) {
          this.logger.warn(
            `first-tick resetStuckProcessing failed: ${(err as Error).message} — will retry on next tick`,
          );
          // Leave the latch down so the next tick retries the reset.
          return;
        }
        this.firstReconcileDone = true;
      }
      await this.reconcileNewJobPosts();
    } catch (err) {
      this.logger.warn(
        `queueReconcileTick failed: ${(err as Error).message} — rows stay NEW and will be retried on next tick`,
      );
    } finally {
      this.reconciling = false;
    }
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
