import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import {
  ATTACHMENT_PROCESS,
  ATTACHMENT_QUEUE,
} from './attachment-queue.constants';

@Injectable()
export class AttachmentQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentQueueService.name);
  private connection: IORedis;
  private queue: Queue;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.connection = new IORedis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue(ATTACHMENT_QUEUE, { connection: this.connection });
    this.logger.log(`Queue "${ATTACHMENT_QUEUE}" initialized`);
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }

  async enqueue(attachmentId: string): Promise<void> {
    await this.queue.add(
      ATTACHMENT_PROCESS,
      { attachmentId },
      {
        jobId: attachmentId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.debug(`Enqueued attachment ${attachmentId}`);
  }
}
