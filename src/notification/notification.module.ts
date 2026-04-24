import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DiscordNotificationService } from './discord.service';
import { NotificationProcessorService } from './notification.processor';
import { NotificationService } from './notification.service';

@Module({
  imports: [ConfigModule],
  providers: [
    NotificationService,
    NotificationProcessorService,
    DiscordNotificationService,
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
