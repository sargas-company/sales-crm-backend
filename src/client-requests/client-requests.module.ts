import { Module } from '@nestjs/common';

import { NotificationModule } from '../notification/notification.module';
import { ClientRequestsController } from './client-requests.controller';
import { ClientRequestsService } from './client-requests.service';

@Module({
  imports: [NotificationModule],
  controllers: [ClientRequestsController],
  providers: [ClientRequestsService],
})
export class ClientRequestsModule {}
