import { Module } from '@nestjs/common';

import { PayrollModule } from '../payroll/payroll.module';
import { CompensationAnalyticsController } from './compensation-analytics.controller';
import { CompensationAnalyticsService } from './compensation-analytics.service';

@Module({
  imports: [PayrollModule],
  controllers: [CompensationAnalyticsController],
  providers: [CompensationAnalyticsService],
})
export class CompensationAnalyticsModule {}
