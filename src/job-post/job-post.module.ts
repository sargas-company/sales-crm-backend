import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { AiJobEvaluatorService } from './ai-job-evaluator.service';
import { JobPostController } from './job-post.controller';
import { JobPostProcessorService } from './job-post-processor.service';
import { JobPostQueueService } from './job-post-queue.service';
import { JobPostService } from './job-post.service';

@Module({
  imports: [PrismaModule],
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
