import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';

import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
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
    private readonly settings: SettingsService,
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
      Sentry.captureException(err, {
        tags: { service: 'llm-analyzer' },
        extra: { jobPostId: (job?.data as { jobPostId?: string })?.jobPostId },
      });
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
    await this.processJobPost(jobPostId, {
      attempt: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
    });
  }

  /**
   * Business logic lifted out of the BullMQ shim so it can be driven
   * from tests without a Redis-backed Job. Pipeline:
   *
   *   NEW → PROCESSING
   *   → scanner.analysisEnabled kill-switch
   *   → gatekeeper (fit? reason)
   *     ├─ fit=false → PROCESSED, decision=decline, matchScore=0,
   *     │              priority=low, aiResponse={gatekeeper:{...}}
   *     │              → NO full evaluate, NO notification.
   *     └─ fit=true  → full evaluate → PROCESSED, decision/
   *                    matchScore/priority/aiResponse, notification
   *                    on approve|maybe (existing path).
   *
   * Any throw (gatekeeper or evaluator) rolls the status back to NEW
   * for retry; the FAILED terminal state is only reached on the last
   * BullMQ attempt. Errors are NOT masked as decline.
   */
  async processJobPost(
    jobPostId: string,
    options: { attempt: number; maxAttempts: number },
  ): Promise<void> {
    const { count } = await this.prisma.jobPost.updateMany({
      where: { id: jobPostId, status: 'NEW' },
      data: { status: 'PROCESSING' },
    });
    if (count === 0) {
      this.logger.warn(`JobPost ${jobPostId} already taken, skipping`);
      return;
    }

    const analysisEnabled = await this.settings.getBooleanForKey(
      SK.SCANNER_ANALYSIS_ENABLED,
      true,
    );
    if (!analysisEnabled) {
      this.logger.warn(
        `JobPost ${jobPostId}: analysis disabled by settings — leaving as NEW`,
      );
      await this.prisma.jobPost.update({
        where: { id: jobPostId },
        data: { status: 'NEW' },
      });
      return;
    }

    try {
      this.logger.log(`Processing jobPost: ${jobPostId}`);

      const jobPost = await this.prisma.jobPost.findUnique({
        where: { id: jobPostId },
        select: { rawText: true },
      });

      // ── Gatekeeper gate: a cheap pre-filter the AI evaluator does
      //    NOT need to run for obvious rejects. Business rules live
      //    in JOB_GATEKEEPER_PROMPT, not inline here.
      const gate = await this.aiEvaluator.gate(jobPost!.rawText);
      if (!gate.fit) {
        await this.prisma.jobPost.update({
          where: { id: jobPostId },
          data: {
            decision: 'decline',
            matchScore: 0,
            priority: 'low',
            aiResponse: { gatekeeper: { fit: false, reason: gate.reason } },
            status: 'PROCESSED',
            processedAt: new Date(),
          },
        });
        this.logger.log(
          `Gatekeeper declined jobPost: ${jobPostId} — ${gate.reason}`,
        );
        return;
      }

      // ── Fit → full evaluation.
      const result = await this.aiEvaluator.evaluate(jobPost!.rawText);

      const processed = await this.prisma.jobPost.update({
        where: { id: jobPostId },
        data: {
          decision: result.decision,
          matchScore: result.matchScore,
          priority: result.priority,
          aiResponse: {
            gatekeeper: { fit: true, reason: gate.reason },
            evaluation: result.aiResponse,
          },
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
      const isLastAttempt = options.attempt + 1 >= options.maxAttempts;
      await this.prisma.jobPost.update({
        where: { id: jobPostId },
        data: { status: isLastAttempt ? 'FAILED' : 'NEW' },
      });
      throw err;
    }
  }
}
