import { Module } from '@nestjs/common';

import { ClientRequestsController } from './client-requests.controller';
import { ClientRequestsService } from './client-requests.service';

@Module({
  controllers: [ClientRequestsController],
  providers: [ClientRequestsService],
})
export class ClientRequestsModule {}
