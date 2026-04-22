import { Module } from '@nestjs/common';

import { JobPostModule } from '../job-post/job-post.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramListenerService } from './telegram-listener.service';

@Module({
  imports: [PrismaModule, JobPostModule],
  providers: [TelegramListenerService],
})
export class TelegramModule {}
