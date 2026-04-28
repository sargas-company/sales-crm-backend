import { Module } from '@nestjs/common';

import { NotificationModule } from '../notification/notification.module';
import { CallReminderService } from './call-reminder.service';
import { ClientCallsController } from './client-calls.controller';
import { ClientCallsService } from './client-calls.service';

@Module({
  imports: [NotificationModule],
  controllers: [ClientCallsController],
  providers: [ClientCallsService, CallReminderService],
  exports: [ClientCallsService],
})
export class ClientCallsModule {}
