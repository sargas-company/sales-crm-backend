import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { MessageAttachmentStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ChatGateway } from '../chat.gateway';
import {
  ATTACHMENT_PROCESS,
  ATTACHMENT_QUEUE,
} from './attachment-queue.constants';
import { AttachmentPreprocessorService } from './attachment-preprocessor.service';
import { MessageReadinessService } from './message-readiness.service';

const MAX_ATTEMPTS = 3;

@Injectable()
export class AttachmentProcessorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AttachmentProcessorService.name);
  private connection: IORedis;
  private worker: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly attachmentPreprocessor: AttachmentPreprocessorService,
    private readonly gateway: ChatGateway,
    private readonly readiness: MessageReadinessService,
  ) {}

  onModuleInit() {
    this.connection = new IORedis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
      maxRetriesPerRequest: null,
    });

    this.worker = new Worker(ATTACHMENT_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 2,
      lockDuration: 60_000,
    });

    // Safety-net: fires when BullMQ exhausts all job-level retries unexpectedly
    // (e.g. DB error on the attempts-increment itself). At MAX_ATTEMPTS the
    // process() method handles FAILED in DB and emits the socket event itself,
    // then returns without throwing — so BullMQ marks the job completed and this
    // handler never fires for the normal failure path.
    // Socket emit intentionally omitted here to keep FAILED ownership in process().
    this.worker.on('failed', (job, err) => {
      if (!job) return;
      const { attachmentId } = job.data as { attachmentId: string };
      this.logger.error(
        `BullMQ exhausted retries for attachment ${attachmentId}: ${err.message}`,
      );
      void this.prisma.messageAttachment
        .update({
          where: { id: attachmentId },
          data: { status: 'FAILED' as never, error: err.message },
        })
        .catch((e: unknown) => {
          this.logger.error(
            `Failed to mark attachment ${attachmentId} as FAILED`,
            e instanceof Error ? e.stack : String(e),
          );
        });
    });

    this.logger.log(`Worker for "${ATTACHMENT_QUEUE}" started`);
  }

  async onModuleDestroy() {
    await this.worker.close();
    await this.connection.quit();
  }

  private async process(job: Job): Promise<void> {
    if (job.name !== ATTACHMENT_PROCESS) return;

    const { attachmentId } = job.data as { attachmentId: string };

    // Single query — fetch attachment + proposalId for room-scoped broadcast
    const attachment = await this.prisma.messageAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        message: {
          select: {
            chat: {
              select: { proposalId: true },
            },
          },
        },
      },
    });

    if (!attachment) {
      this.logger.warn(`Attachment ${attachmentId} not found, skipping`);
      return;
    }

    // Idempotency guard — DONE and FAILED are the only terminal states
    const status = (attachment as unknown as { status?: string }).status;
    if (status === 'DONE' || status === 'FAILED') {
      this.logger.debug(
        `Attachment ${attachmentId} already in terminal state ${status}, skipping`,
      );
      return;
    }

    const { proposalId } = attachment.message.chat;

    if (!proposalId) {
      this.logger.warn(
        `Attachment ${attachmentId} has no proposalId on chat — broadcast will be skipped`,
      );
    }

    // Set PROCESSING in DB and increment attempts atomically before emitting.
    // Guarantees frontend never sees status=PROCESSING while DB still shows PENDING.
    // parseAndSave will call setStatus(PROCESSING) again — idempotent.
    const updated = await this.prisma.messageAttachment.update({
      where: { id: attachmentId },
      data: {
        attempts: { increment: 1 },
        status: MessageAttachmentStatus.PROCESSING,
      },
    });

    this.emitUpdate(proposalId, {
      attachmentId,
      messageId: attachment.messageId,
      status: 'PROCESSING',
    });

    try {
      await this.attachmentPreprocessor.parseAndSave(attachment);

      this.emitUpdate(proposalId, {
        attachmentId,
        messageId: attachment.messageId,
        status: 'DONE',
      });

      await this.readiness
        .checkMessageReadiness(attachment.messageId)
        .catch((e: unknown) => {
          this.logger.error(
            `readiness check failed after DONE for message ${attachment.messageId}`,
            e instanceof Error ? e.stack : String(e),
          );
        });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      if (updated.attempts >= MAX_ATTEMPTS) {
        // Permanent failure — set FAILED in DB, don't re-throw (stops BullMQ retries)
        await this.prisma.messageAttachment
          .update({
            where: { id: attachmentId },
            data: { status: 'FAILED' as never, error: errMsg },
          })
          .catch((e: unknown) => {
            this.logger.error(
              `Could not mark attachment ${attachmentId} as FAILED`,
              e instanceof Error ? e.stack : String(e),
            );
          });

        this.emitUpdate(proposalId, {
          attachmentId,
          messageId: attachment.messageId,
          status: 'FAILED',
          error: errMsg,
        });

        await this.readiness
          .checkMessageReadiness(attachment.messageId)
          .catch((e: unknown) => {
            this.logger.error(
              `readiness check failed after FAILED for message ${attachment.messageId}`,
              e instanceof Error ? e.stack : String(e),
            );
          });

        this.logger.error(
          `Attachment ${attachmentId} permanently failed after ${updated.attempts} attempts: ${errMsg}`,
        );
        return; // intentionally NOT re-throwing
      }

      // Still have attempts left — re-throw so BullMQ schedules a retry
      this.logger.warn(
        `Attachment ${attachmentId} failed (attempt ${updated.attempts}/${MAX_ATTEMPTS}), will retry`,
      );
      throw error;
    }
  }

  private emitUpdate(
    proposalId: string | null,
    payload: {
      attachmentId: string;
      messageId: string;
      status: string;
      error?: string | null;
    },
  ): void {
    if (!proposalId) return;
    this.gateway.broadcastAttachmentUpdate(proposalId, payload);
  }
}
