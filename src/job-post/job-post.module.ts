import { Module } from '@nestjs/common';

import { NotificationModule } from '../notification/notification.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PromptModule } from '../prompt/prompt.module';
import { AiJobEvaluatorService } from './ai-job-evaluator.service';
import { JobPostController } from './job-post.controller';
import { JobPostProcessorService } from './job-post-processor.service';
import { JobPostQueueService } from './job-post-queue.service';
import { JobPostService } from './job-post.service';

@Module({
  imports: [PrismaModule, PromptModule, NotificationModule],
  controllers: [JobPostController],
  providers: [
    JobPostQueueService,
    JobPostProcessorService,
    AiJobEvaluatorService,
    JobPostService,
  ],
  exports: [JobPostQueueService, AiJobEvaluatorService],
})
export class JobPostModule {}
