import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AiJobEvaluatorService } from './ai-job-evaluator.service';
import { JOB_POST_PROCESS, JOB_POST_QUEUE } from './job-post.constants';

@Injectable()
export class JobPostProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobPostProcessorService.name);
  private connection: IORedis;
  private worker: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly aiEvaluator: AiJobEvaluatorService,
    private readonly notificationService: NotificationService,
  ) {}

  onModuleInit() {
    this.connection = new IORedis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
      maxRetriesPerRequest: null,
    });

    this.worker = new Worker(JOB_POST_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 2,
      limiter: { max: 2, duration: 5000 },
      lockDuration: 120000, // 2 min — AI calls can be slow
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });

    this.logger.log(`Worker for "${JOB_POST_QUEUE}" started`);
  }

  async onModuleDestroy() {
    await this.worker.close();
    await this.connection.quit();
  }

  private async process(job: Job) {
    if (job.name !== JOB_POST_PROCESS) return;

    const { jobPostId } = job.data as { jobPostId: string };

    const { count } = await this.prisma.jobPost.updateMany({
      where: { id: jobPostId, status: 'NEW' },
      data: { status: 'PROCESSING' },
    });

    if (count === 0) {
      this.logger.warn(`JobPost ${jobPostId} already taken, skipping`);
      return;
    }

    try {
      this.logger.log(`Processing jobPost: ${jobPostId}`);

      const jobPost = await this.prisma.jobPost.findUnique({
        where: { id: jobPostId },
        select: { rawText: true },
      });

      const result = await this.aiEvaluator.evaluate(jobPost!.rawText);

      const processed = await this.prisma.jobPost.update({
        where: { id: jobPostId },
        data: {
          decision: result.decision,
          matchScore: result.matchScore,
          priority: result.priority,
          aiResponse: result.aiResponse,
          status: 'PROCESSED',
          processedAt: new Date(),
        },
      });

      if (
        processed.matchScore != null &&
        (processed.decision === 'approve' || processed.decision === 'maybe')
      ) {
        try {
          await this.notificationService.createEvent(
            NotificationType.JOB_POST_MATCH,
            {
              jobPostId: processed.id,
              score: processed.matchScore,
              title: processed.title ?? null,
              url: processed.jobUrl ?? null,
              decision: processed.decision ?? null,
              priority: processed.priority ?? null,
              rawText: processed.rawText.slice(0, 4096),
            },
          );
        } catch (err) {
          this.logger.error(
            `Failed to create NotificationEvent for jobPost ${jobPostId}: ${(err as Error).message}`,
          );
        }
      }

      this.logger.log(
        `Processed jobPost: ${jobPostId} → ${result.decision} (${result.matchScore})`,
      );
    } catch (err) {
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      await this.prisma.jobPost.update({
        where: { id: jobPostId },
        data: { status: isLastAttempt ? 'FAILED' : 'NEW' },
      });

      throw err;
    }
  }
}
