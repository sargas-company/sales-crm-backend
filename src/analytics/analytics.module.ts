import { Module } from '@nestjs/common';

import { JobPostModule } from '../job-post/job-post.module';
import { LiveEventsModule } from '../live-events/live-events.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsStreamController } from './analytics-stream.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [JobPostModule, LiveEventsModule],
  controllers: [AnalyticsController, AnalyticsStreamController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
