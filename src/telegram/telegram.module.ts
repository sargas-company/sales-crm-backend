import { Module } from '@nestjs/common';

import { JobPostModule } from '../job-post/job-post.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { TelegramAuthController } from './telegram-auth.controller';
import { TelegramAuthService } from './telegram-auth.service';
import { TelegramListenerService } from './telegram-listener.service';

@Module({
  imports: [PrismaModule, JobPostModule, SettingsModule],
  controllers: [TelegramAuthController],
  providers: [TelegramListenerService, TelegramAuthService],
})
export class TelegramModule {}
