import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DiscordIntegrationModule } from '../discord-integration/discord-integration.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { DiscordNotificationService } from './discord.service';
import { JobPostDiscordNotifierService } from './job-post-discord-notifier.service';
import { NotificationProcessorService } from './notification.processor';
import { NotificationService } from './notification.service';

@Module({
  imports: [ConfigModule, PrismaModule, SettingsModule, DiscordIntegrationModule],
  providers: [
    NotificationService,
    NotificationProcessorService,
    DiscordNotificationService,
    JobPostDiscordNotifierService,
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
