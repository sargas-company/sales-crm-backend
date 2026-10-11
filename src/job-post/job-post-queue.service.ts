import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { PrismaService } from '../prisma/prisma.service';
import { JOB_POST_PROCESS, JOB_POST_QUEUE } from './job-post.constants';

/**
 * Owns the BullMQ Queue handle for `job-post-processing`.
 *
 * `onModuleInit` deliberately does the minimum: open the Redis
 * connection and construct the Queue. Nothing else. In particular
 * it DOES NOT:
 *   - scan `JobPost` for stuck PROCESSING rows;
 *   - fetch pending NEW rows;
 *   - call `enqueue()` in a loop.
 *
 * All of those were previously inside this `onModuleInit`, and under
 * a backlog they held up Nest's bootstrap chain long enough that
 * `app.listen()` was never reached and the HTTP port never opened.
 *
 * Boot-time recovery (PROCESSING → NEW, then enqueue every NEW) is
 * now owned by `VibeIngestScheduler.queueReconcileTick`, which runs
 * after `app.listen()` has already returned. The first scheduler
 * tick performs the one-off reset; subsequent ticks only re-enqueue
 * NEW rows.
 */
@Injectable()
export class JobPostQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobPostQueueService.name);
  private connection: IORedis;
  private queue: Queue;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    this.connection = new IORedis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
      maxRetriesPerRequest: null,
    });

    // `BULLMQ_PREFIX` is set by the jest-isolation hook (per-worker
    // test prefix). In production/normal runs the env var is unset
    // and BullMQ uses its default (`bull`) — the previous behaviour.
    const prefix = process.env.BULLMQ_PREFIX || undefined;
    this.queue = new Queue(JOB_POST_QUEUE, {
      connection: this.connection,
      ...(prefix ? { prefix } : {}),
    });
    this.logger.log(
      `Queue "${JOB_POST_QUEUE}" initialized${prefix ? ` [prefix=${prefix}]` : ''}`,
    );
    // Intentionally no await on any Prisma or Redis queue operation
    // beyond Queue construction — see class doc. Recovery lives in
    // VibeIngestScheduler.queueReconcileTick.
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }

  /**
   * One-off startup recovery previously done inside `onModuleInit`,
   * now driven by the scheduler after `app.listen()` has returned.
   *
   * Flips genuinely-stuck PROCESSING rows back to NEW. A row is
   * "stuck" only when its `createdAt` is older than
   * `stuckOlderThanMs` (default: 10 minutes). JobPost has no
   * `updatedAt`, so `createdAt` is the only time column available;
   * the 10-minute floor is deliberately conservative so a rolling
   * deploy or a second active instance cannot wake up to find its
   * in-flight rows yanked back to NEW. Returns the count of rows
   * reset.
   */
  /**
   * BullMQ-side counters for the scanner panel. The states returned
   * match the ones that actually describe "pending" or "in-flight"
   * work in BullMQ 5: `waiting` (ready to run), `delayed`
   * (scheduled retry after a transient error), `active` (worker is
   * running), `paused` (queue is paused globally), `prioritized`
   * (reserved for future fresh-vs-backlog priority split; included
   * so a later change doesn't miss a counter).
   *
   * Called from `/job-posts/queue-stats` which the frontend polls
   * every ~5s — hence the ONE round-trip via `getJobCounts()` and
   * the explicit state list.
   */
  async queueCounts(): Promise<{
    waiting: number;
    delayed: number;
    active: number;
    paused: number;
    prioritized: number;
  }> {
    const counts = await this.queue.getJobCounts(
      'waiting',
      'delayed',
      'active',
      'paused',
      'prioritized',
    );
    return {
      waiting: counts.waiting ?? 0,
      delayed: counts.delayed ?? 0,
      active: counts.active ?? 0,
      paused: counts.paused ?? 0,
      prioritized: counts.prioritized ?? 0,
    };
  }

  async resetStuckProcessing(stuckOlderThanMs = 10 * 60 * 1000): Promise<number> {
    // Only reset PROCESSING rows that are NOT currently active in
    // Redis. The previous "age by createdAt" rule would yank a
    // long-running analysis back to NEW just because the JobPost
    // row was old. We now cross-check Redis: a PROCESSING row with
    // a live active BullMQ job is REAL work — leave it alone.
    const cutoff = new Date(Date.now() - stuckOlderThanMs);
    const candidates = await this.prisma.jobPost.findMany({
      where: {
        status: 'PROCESSING',
        OR: [
          { enqueuedAt: null, createdAt: { lt: cutoff } },
          { enqueuedAt: { lt: cutoff } },
        ],
      },
      select: { id: true },
      take: 500,
    });
    if (candidates.length === 0) return 0;

    const activeIds = await this.collectActiveJobPostIds().catch(() => null);
    const stuckIds: string[] = [];
    for (const row of candidates) {
      // Can't verify against Redis → err on the side of safety and
      // leave the row alone. The sweep will try again next tick.
      if (activeIds === null) continue;
      if (!activeIds.has(row.id)) stuckIds.push(row.id);
    }
    if (stuckIds.length === 0) return 0;

    const { count } = await this.prisma.jobPost.updateMany({
      where: { id: { in: stuckIds }, status: 'PROCESSING' },
      data: { status: 'NEW' },
    });
    if (count > 0) {
      this.logger.warn(
        `Deferred recovery: reset ${count} PROCESSING rows (not in Redis active) → NEW`,
      );
    }
    return count;
  }

  /**
   * Collects the JobPost ids currently in the BullMQ `active` state.
   * BullMQ job name/data holds `jobPostId`, so we map through that.
   * Returns an empty set when there are no active jobs; throws on
   * a transient Redis error so the caller can treat the result as
   * "unknown" instead of "empty".
   */
  private async collectActiveJobPostIds(): Promise<Set<string>> {
    const activeJobs = await this.queue.getActive(0, 999);
    const ids = new Set<string>();
    for (const job of activeJobs) {
      const data = job.data as { jobPostId?: string } | undefined;
      if (data?.jobPostId) ids.add(data.jobPostId);
    }
    return ids;
  }

  /**
   * Walks a bounded slice of `status=NEW AND enqueueState=ENQUEUED`
   * rows and verifies each one still has a BullMQ job in Redis. Rows
   * whose job is gone (Redis flush, terminal cleanup race, etc.) are
   * flipped back to PENDING so the scheduler's reconcile tick picks
   * them up on its next pass. A Redis outage short-circuits — we
   * never flip a row to PENDING without a confirmed negative, since
   * that would create duplicate work when Redis comes back.
   *
   * Deterministic jobId is preserved: we only move DB state and let
   * the reconcile tick call `enqueue()` for us (which handles the
   * deterministic-id de-dup correctly).
   */
  async reconcileLostEnqueued(batchSize = 100): Promise<number> {
    const rows = await this.prisma.jobPost.findMany({
      where: { status: 'NEW', enqueueState: 'ENQUEUED' },
      select: { id: true },
      take: batchSize,
    });
    if (rows.length === 0) return 0;

    let lostIds: string[] = [];
    try {
      // getJob is a quick HMGET; batched sequentially to avoid
      // flooding Redis in a single pipeline. One tick processes at
      // most `batchSize` rows, so cost is bounded.
      for (const row of rows) {
        const job = await this.queue.getJob(`${row.id}-v1`);
        if (!job) lostIds.push(row.id);
      }
    } catch (err) {
      this.logger.warn(
        `reconcileLostEnqueued aborted (Redis unavailable): ${(err as Error).message}`,
      );
      return 0;
    }

    if (lostIds.length === 0) return 0;

    const { count } = await this.prisma.jobPost.updateMany({
      where: {
        id: { in: lostIds },
        status: 'NEW',
        enqueueState: 'ENQUEUED',
      },
      data: { enqueueState: 'PENDING' },
    });
    if (count > 0) {
      this.logger.warn(
        `reconcileLostEnqueued: ${count} ENQUEUED rows had no Redis job → PENDING (will re-enqueue next tick)`,
      );
    }
    return count;
  }

  /**
   * Idempotent, outbox-aware handoff to BullMQ.
   *
   * Three possible BullMQ states for the deterministic jobId
   * `${jobPostId}-v1`:
   *
   *   1. absent → add a fresh job.
   *   2. live (waiting / delayed / active) → the previous enqueue
   *      is still in flight (BullMQ's own backoff may hold it
   *      delayed). Do NOT add — that would race BullMQ's attempts
   *      counter and double-charge AI. Just reconfirm DB state.
   *   3. terminal (completed / failed) → stale ghost from a
   *      previous lifecycle (e.g. the row was paused back to
   *      BACKLOG and now the operator re-enabled it). Remove the
   *      ghost first, then add fresh.
   *
   * Transient Anthropic errors retry via BullMQ attempts; permanent
   * validation errors throw non-retryable from the processor.
   *
   * DB transaction and Redis call stay DELIBERATELY separate: a
   * long-open Postgres transaction around a Redis await couples two
   * availability domains unnecessarily.
   */
  async enqueue(jobPostId: string) {
    const jobId = `${jobPostId}-v1`;
    try {
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState().catch(() => 'unknown');
        if (state === 'completed' || state === 'failed') {
          this.logger.log(
            `enqueue(${jobPostId}): removing stale ${state} job before re-adding`,
          );
          await existing.remove().catch(() => undefined);
        } else {
          // waiting / delayed / active → BullMQ owns the retry;
          // don't disturb it. The DB row is already (or will be)
          // flipped to ENQUEUED further down.
          await this.prisma.jobPost.update({
            where: { id: jobPostId },
            data: { enqueueState: 'ENQUEUED', enqueuedAt: new Date() },
          });
          return;
        }
      }
      await this.queue.add(
        JOB_POST_PROCESS,
        { jobPostId },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 24 * 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      );
    } catch (err) {
      this.logger.warn(
        `queue.add failed for JobPost ${jobPostId}: ${(err as Error).message}` +
          ' — row stays PENDING; scheduler will retry next tick',
      );
      throw err;
    }
    await this.prisma.jobPost.update({
      where: { id: jobPostId },
      data: { enqueueState: 'ENQUEUED', enqueuedAt: new Date() },
    });
  }

  /**
   * Pauses / resumes the queue globally. BullMQ pause is persisted
   * in Redis — all worker instances see it on their next poll, and
   * already-active jobs are allowed to finish. On resume, waiting
   * jobs start flowing again. Idempotent.
   */
  async pause(): Promise<void> {
    await this.queue.pause();
    this.logger.log('BullMQ queue paused (all workers will stop picking)');
  }

  async resume(): Promise<void> {
    await this.queue.resume();
    this.logger.log('BullMQ queue resumed');
  }

  /**
   * Reconciles BullMQ pause-state to the given target. Used by the
   * scheduler to recover from a scenario where the operator flipped
   * the setting but the queue state drifted (e.g. a worker crash
   * mid-pause). Safe to call on every tick.
   */
  async reconcilePauseState(shouldBePaused: boolean): Promise<void> {
    const isPaused = await this.queue.isPaused();
    if (isPaused && !shouldBePaused) await this.resume();
    else if (!isPaused && shouldBePaused) await this.pause();
  }

  /**
   * Removes a specific JobPost's current BullMQ job if any. Used by
   * `bulkSkip` / `bulkRemove` so a stale job doesn't waste AI budget
   * on a row the operator already dismissed. Idempotent.
   */
  async forgetJob(jobPostId: string): Promise<void> {
    const job = await this.queue.getJob(`${jobPostId}-v1`);
    if (job) {
      await job.remove().catch(() => undefined);
    }
  }
}
