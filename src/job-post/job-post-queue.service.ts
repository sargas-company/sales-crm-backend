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

    await this.recover();
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }

  private async recover() {
    const { count: resetCount } = await this.prisma.jobPost.updateMany({
      where: { status: 'PROCESSING' },
      data: { status: 'NEW' },
    });

    if (resetCount > 0) {
      this.logger.warn(`Recovery: reset ${resetCount} stuck PROCESSING → NEW`);
    }

    const pending = await this.prisma.jobPost.findMany({
      where: { status: 'NEW' },
      select: { id: true },
    });

    if (pending.length === 0) return;

    await Promise.all(pending.map((p) => this.enqueue(p.id)));
    this.logger.log(`Recovery: enqueued ${pending.length} pending jobs`);
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
