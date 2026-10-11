import { Global, Module } from '@nestjs/common';

import { LiveEventsService } from './live-events.service';

@Global()
@Module({
  providers: [LiveEventsService],
  exports: [LiveEventsService],
})
export class LiveEventsModule {}
