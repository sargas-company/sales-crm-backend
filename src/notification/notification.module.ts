import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SettingsModule } from '../settings/settings.module';
import { DiscordNotificationService } from './discord.service';
import { NotificationProcessorService } from './notification.processor';
import { NotificationService } from './notification.service';

@Module({
  imports: [ConfigModule, SettingsModule],
  providers: [
    NotificationService,
    NotificationProcessorService,
    DiscordNotificationService,
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
