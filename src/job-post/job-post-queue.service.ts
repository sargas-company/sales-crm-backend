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

    this.queue = new Queue(JOB_POST_QUEUE, { connection: this.connection });
    this.logger.log(`Queue "${JOB_POST_QUEUE}" initialized`);
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
  async resetStuckProcessing(stuckOlderThanMs = 10 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - stuckOlderThanMs);
    const { count } = await this.prisma.jobPost.updateMany({
      where: { status: 'PROCESSING', createdAt: { lt: cutoff } },
      data: { status: 'NEW' },
    });
    if (count > 0) {
      this.logger.warn(
        `Deferred recovery: reset ${count} PROCESSING rows older than ${stuckOlderThanMs}ms → NEW`,
      );
    }
    return count;
  }

  async enqueue(jobPostId: string) {
    await this.queue.add(
      JOB_POST_PROCESS,
      { jobPostId },
      {
        jobId: jobPostId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    );
  }
}
