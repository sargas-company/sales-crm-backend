import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { PrismaService } from '../../prisma/prisma.service';
import {
  ATTACHMENT_PROCESS,
  ATTACHMENT_QUEUE,
} from './attachment-queue.constants';
import { AttachmentPreprocessorService } from './attachment-preprocessor.service';

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

    // Safety-net: fires when BullMQ exhausts all job-level retries
    this.worker.on('failed', (job, err) => {
      if (!job) return;
      const { attachmentId } = job.data as { attachmentId: string };
      this.logger.error(
        `BullMQ exhausted retries for attachment ${attachmentId}: ${err.message}`,
      );
      this.prisma.messageAttachment
        .update({
          where: { id: attachmentId },
          data: {
            status: 'FAILED' as never,
            error: err.message,
          },
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

    const attachment = await this.prisma.messageAttachment.findUnique({
      where: { id: attachmentId },
    });

    if (!attachment) {
      this.logger.warn(`Attachment ${attachmentId} not found, skipping`);
      return;
    }

    // Skip terminal states — idempotency guard
    const status = (attachment as unknown as { status?: string }).status;
    if (
      status === 'DONE' ||
      status === 'FAILED' ||
      status === 'TIMEOUT'
    ) {
      this.logger.debug(
        `Attachment ${attachmentId} already in terminal state ${status}, skipping`,
      );
      return;
    }

    // Increment DB attempt counter before parsing
    const updated = await this.prisma.messageAttachment.update({
      where: { id: attachmentId },
      data: { attempts: { increment: 1 } },
    });

    try {
      await this.attachmentPreprocessor.parseAndSave(attachment);
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
}
