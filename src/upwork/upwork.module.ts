import { Module } from '@nestjs/common';

import { AuditEventModule } from '../audit-event/audit-event.module';

import { UpworkController } from './upwork.controller';
import { UpworkAnalyticsService } from './upwork-analytics.service';
import { UpworkChangeLogService } from './upwork-change-log.service';
import { UpworkMetricsService } from './upwork-metrics.service';
import { UpworkProfileService } from './upwork-profile.service';
import { UpworkReferenceDataService } from './upwork-reference-data.service';
import { UpworkRemindersService } from './upwork-reminders.service';

@Module({
  imports: [AuditEventModule],
  controllers: [UpworkController],
  providers: [
    UpworkProfileService,
    UpworkReferenceDataService,
    UpworkChangeLogService,
    UpworkMetricsService,
    UpworkRemindersService,
    UpworkAnalyticsService,
  ],
})
export class UpworkModule {}
