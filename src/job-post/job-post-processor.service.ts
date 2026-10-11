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
import { NotificationType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import {
  AiJobEvaluatorService,
  EvaluatorResponseError,
  GATE_REJECT_THRESHOLD,
  GatekeeperResponseError,
} from './ai-job-evaluator.service';
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

    // `BULLMQ_PREFIX` is set by jest-isolation (per-worker test
    // prefix). Normal/production runs leave it unset and BullMQ
    // uses the default `bull` prefix. Prefix MUST match the Queue
    // producer side (JobPostQueueService), otherwise the Worker
    // reads from a different namespace and sees zero jobs.
    const prefix = process.env.BULLMQ_PREFIX || undefined;
    this.worker = new Worker(JOB_POST_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 2,
      limiter: { max: 2, duration: 5000 },
      lockDuration: 120000, // 2 min — AI calls can be slow
      ...(prefix ? { prefix } : {}),
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
      // Worker picked the row but the operator paused AI after
      // ingestion. Hand the row back as BACKLOG (not PENDING!) so
      // the scheduler's reconcile tick does NOT re-enqueue it in a
      // loop. The next enable-analysis call will promote
      // BACKLOG → PENDING per the operator's strategy; the stale
      // completed BullMQ job for this row's current version will be
      // removed by `enqueue()`'s terminal-state cleanup when the
      // row is re-pushed.
      this.logger.warn(
        `JobPost ${jobPostId}: analysis disabled — rolling back to NEW/BACKLOG`,
      );
      await this.prisma.jobPost.update({
        where: { id: jobPostId },
        data: { status: 'NEW', enqueueState: 'BACKLOG' },
      });
      return;
    }

    try {
      this.logger.log(`Processing jobPost: ${jobPostId}`);

      const jobPost = await this.prisma.jobPost.findUnique({
        where: { id: jobPostId },
        select: { rawText: true },
      });

      // ── Stage 1: Gatekeeper (Haiku) returns { fit, confidence, reason }.
      //    Reject at the gate ONLY when fit=false AND confidence is
      //    high. Low-confidence false still proceeds to Sonnet, so a
      //    hesitant Haiku doesn't silently kill borderline posts.
      const gate = await this.aiEvaluator.gate(jobPost!.rawText);
      const gateRejected =
        !gate.fit && gate.confidence >= GATE_REJECT_THRESHOLD;
      if (gateRejected) {
        await this.prisma.jobPost.update({
          where: { id: jobPostId },
          data: {
            decision: 'decline',
            matchScore: 0,
            priority: 'low',
            aiResponse: {
              gatekeeper: {
                fit: false,
                confidence: gate.confidence,
                reason: gate.reason,
                usage: gate.usage,
              },
            },
            status: 'PROCESSED',
            processedAt: new Date(),
            lastAnalysisAt: new Date(),
            lastAnalysisError: null,
            analysisModelVersion: gate.usage.model,
            enqueueState: null,
          },
        });
        this.logger.log(
          `Gatekeeper rejected jobPost ${jobPostId} (confidence=${gate.confidence}): ${gate.reason}`,
        );
        return;
      }

      // ── Stage 2: Sonnet full evaluation.
      const result = await this.aiEvaluator.evaluate(jobPost!.rawText);

      const processed = await this.prisma.jobPost.update({
        where: { id: jobPostId },
        data: {
          decision: result.decision,
          matchScore: result.matchScore,
          priority: result.priority,
          aiResponse: {
            gatekeeper: {
              fit: gate.fit,
              confidence: gate.confidence,
              reason: gate.reason,
              usage: gate.usage,
            },
            evaluation: {
              reasoning: result.reasoning,
              strengths: result.strengths,
              risks: result.risks,
              scopeClarity: result.scopeClarity,
              quickWin: result.quickWin,
              effortEstimate: result.effortEstimate,
              raw: result.raw as Prisma.InputJsonValue,
              usage: result.usage,
            },
          } as Prisma.InputJsonValue,
          status: 'PROCESSED',
          processedAt: new Date(),
          lastAnalysisAt: new Date(),
          lastAnalysisError: null,
          analysisModelVersion: result.usage.model,
          enqueueState: null,
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
      // Permanent validation errors (gatekeeper / evaluator returned
      // schema-invalid output) do not benefit from a retry — the
      // same prompt against the same model will fail the same way
      // soon. These go straight to FAILED. Transient errors (API
      // 5xx, 429, network) still retry via BullMQ's attempts.
      const isPermanent =
        err instanceof GatekeeperResponseError ||
        err instanceof EvaluatorResponseError;
      const isLastAttempt = options.attempt + 1 >= options.maxAttempts;
      const terminal = isPermanent || isLastAttempt;
      await this.prisma.jobPost.update({
        where: { id: jobPostId },
        data: {
          status: terminal ? 'FAILED' : 'NEW',
          analysisAttempts: { increment: 1 },
          lastAnalysisAt: new Date(),
          lastAnalysisError: sanitiseError((err as Error).message),
          enqueueState: terminal ? null : 'PENDING',
        },
      });
      throw err;
    }
  }
}

function sanitiseError(msg: string): string {
  return msg.replace(/\s+/g, ' ').trim().slice(0, 500);
}
