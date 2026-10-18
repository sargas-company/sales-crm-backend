import { Module } from '@nestjs/common';

import { AiUsageLedgerModule } from '../ai-usage-ledger/ai-usage-ledger.module';
import { JobPostModule } from '../job-post/job-post.module';
import { LiveEventsModule } from '../live-events/live-events.module';
import { AiSpendController } from './ai-spend.controller';
import { AiSpendService } from './ai-spend.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsStreamController } from './analytics-stream.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [JobPostModule, LiveEventsModule, AiUsageLedgerModule],
  controllers: [AnalyticsController, AnalyticsStreamController, AiSpendController],
  providers: [AnalyticsService, AiSpendService],
})
export class AnalyticsModule {}
