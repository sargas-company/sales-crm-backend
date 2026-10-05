import {
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  JobPostIngestStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { JobPostQueueService } from '../../job-post/job-post-queue.service';
import { SettingsService } from '../../settings/settings.service';
import { SK } from '../../settings/settings-registry';
import { mapVibeJobPayload } from './vibe-ingest-mapper';

/**
 * Converts `JobPostIngestEvent(RECEIVED)` rows into `JobPost(NEW)`
 * rows and enqueues them into the existing `job-post-processing`
 * BullMQ queue.
 *
 * Reliability contract:
 *
 *   - Mapping failures (payload shape not recognised, missing job.id)
 *     mark the event as SKIPPED and do NOT create a JobPost.
 *   - A duplicate delivery (same `job.id`) is a no-op on JobPost —
 *     the UNIQUE on `providerJobId` guarantees it. The ingest event
 *     is still linked to the existing JobPost and marked PROCESSED,
 *     and we do NOT re-enqueue a JobPost that is no longer in
 *     `NEW` state. New JobPosts are enqueued once.
 *   - DB write + status transition happen in a single transaction,
 *     so a crash mid-processing can only leave the event in RECEIVED
 *     and never in an inconsistent "linked but not processed" state.
 *   - `enqueue` is called AFTER the transaction. If Redis is down,
 *     the JobPost stays `NEW` and `JobPostQueueService.recover()`
 *     (which runs on module init) picks it up on next backend start.
 *   - Inbox recovery runs ONLY from `VibeIngestScheduler` (every 30s
 *     after `app.listen()` is reached). This service deliberately
 *     does NOT implement `OnModuleInit`, so a large RECEIVED backlog
 *     cannot block Nest from opening the HTTP port on boot — the
 *     scheduler drains the backlog once the app is already serving.
 */
@Injectable()
export class VibeIngestProcessorService {
  private readonly logger = new Logger(VibeIngestProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobPostQueueService,
    private readonly settings: SettingsService,
  ) {}

  /** Entry point used by the webhook controller for the hot path. */
  async processEvent(eventId: string): Promise<void> {
    const analysisDisabled = !(await this.settings.getBooleanForKey(
      SK.SCANNER_ANALYSIS_ENABLED,
      true,
    ));
    if (analysisDisabled) {
      // Analysis is paused by the operator: leave the event RECEIVED
      // so a later drain can pick it up. Do NOT drop it.
      return;
    }
    const event = await this.prisma.jobPostIngestEvent.findUnique({
      where: { id: eventId },
      select: { id: true, status: true, payload: true },
    });
    if (!event || event.status !== JobPostIngestStatus.RECEIVED) return;

    await this.processOne({
      id: event.id,
      payload: event.payload,
    });
  }

  /** Walks every RECEIVED event in order. Called on boot. */
  async drainReceived(): Promise<number> {
    const analysisDisabled = !(await this.settings.getBooleanForKey(
      SK.SCANNER_ANALYSIS_ENABLED,
      true,
    ));
    if (analysisDisabled) return 0;

    const rows = await this.prisma.jobPostIngestEvent.findMany({
      where: { status: JobPostIngestStatus.RECEIVED },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, payload: true },
      take: 500,
    });
    let processed = 0;
    for (const row of rows) {
      try {
        await this.processOne(row);
        processed += 1;
      } catch (err) {
        // Row-level failure already recorded by `processOne` (via
        // `markFailed`); keep draining the next one.
        this.logger.warn(
          `processOne(${row.id}) raised, continuing: ${(err as Error).message}`,
        );
      }
    }
    return processed;
  }

  // ─── core per-event path ──────────────────────────────────────────

  private async processOne(row: {
    id: string;
    payload: Prisma.JsonValue;
  }): Promise<void> {
    const mapped = mapVibeJobPayload(row.payload);
    if (!mapped) {
      await this.markSkipped(row.id, 'payload is not a Vibe job.matched event with job.id');
      return;
    }

    let jobPostId: string;
    let justCreated: boolean;
    try {
      const result = await this.commitLink(row.id, mapped);
      jobPostId = result.jobPostId;
      justCreated = result.justCreated;
    } catch (err) {
      await this.markFailed(row.id, (err as Error).message);
      throw err;
    }

    if (justCreated) {
      try {
        await this.queue.enqueue(jobPostId);
      } catch (err) {
        // DB side is already committed as PROCESSED → JobPost(NEW).
        // The queue-level recovery in JobPostQueueService.onModuleInit
        // will enqueue every NEW JobPost on next boot, so the message
        // never gets lost. We only warn here.
        this.logger.warn(
          `JobPost ${jobPostId} committed but enqueue failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Transactional idempotent link:
   *   - upsert JobPost by providerJobId (never overwrites existing);
   *   - link the ingest event to the resulting JobPost;
   *   - flip event status to PROCESSED.
   *
   * Returns `justCreated=true` only when we actually inserted a new
   * JobPost on this call. A duplicate delivery of the same job.id
   * returns `justCreated=false` and will NOT re-enqueue.
   */
  private async commitLink(
    eventId: string,
    mapped: ReturnType<typeof mapVibeJobPayload> & object,
  ): Promise<{ jobPostId: string; justCreated: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.jobPost.findUnique({
        where: { providerJobId: mapped.providerJobId },
        select: { id: true },
      });
      let jobPostId: string;
      let justCreated: boolean;
      if (existing) {
        jobPostId = existing.id;
        justCreated = false;
      } else {
        const created = await tx.jobPost.create({
          data: {
            providerJobId: mapped.providerJobId,
            rawText: mapped.rawText,
            rawPayload: mapped.rawPayload as Prisma.InputJsonValue,
            title: mapped.title || null,
            jobUrl: mapped.jobUrl || null,
            scanner: mapped.scanner,
            location: mapped.location,
            budget: mapped.budget,
            totalSpent: mapped.totalSpent,
            avgRatePaid: mapped.avgRatePaid,
            hireRate: mapped.hireRate,
            hSkillsKeywords: mapped.hSkillsKeywords,
            status: 'NEW',
          },
          select: { id: true },
        });
        jobPostId = created.id;
        justCreated = true;
      }

      await tx.jobPostIngestEvent.update({
        where: { id: eventId },
        data: {
          status: JobPostIngestStatus.PROCESSED,
          processedAt: new Date(),
          jobPostId,
          error: null,
          attempts: { increment: 1 },
        },
      });
      return { jobPostId, justCreated };
    });
  }

  private async markSkipped(eventId: string, reason: string): Promise<void> {
    await this.prisma.jobPostIngestEvent.update({
      where: { id: eventId },
      data: {
        status: JobPostIngestStatus.SKIPPED,
        processedAt: new Date(),
        error: reason.slice(0, 500),
      },
    });
  }

  private async markFailed(eventId: string, reason: string): Promise<void> {
    await this.prisma.jobPostIngestEvent.update({
      where: { id: eventId },
      data: {
        status: JobPostIngestStatus.FAILED,
        error: reason.slice(0, 500),
        attempts: { increment: 1 },
      },
    });
  }
}
