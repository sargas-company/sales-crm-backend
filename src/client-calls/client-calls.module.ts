import { Module } from '@nestjs/common';

import { ClientCallsController } from './client-calls.controller';
import { ClientCallsService } from './client-calls.service';

@Module({
  controllers: [ClientCallsController],
  providers: [ClientCallsService],
  exports: [ClientCallsService],
})
export class ClientCallsModule {}
