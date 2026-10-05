import { Module } from '@nestjs/common';

import { FinanceWeeklyController } from './finance-weekly.controller';
import { FinanceWeeklyService } from './finance-weekly.service';
import { FinanceAnalyticsService } from './finance-analytics.service';
import { ProjectPaymentRuleController } from './project-payment-rule.controller';
import { ProjectPaymentRuleService } from './project-payment-rule.service';

@Module({
  controllers: [FinanceWeeklyController, ProjectPaymentRuleController],
  providers: [FinanceWeeklyService, FinanceAnalyticsService, ProjectPaymentRuleService],
  exports: [FinanceWeeklyService, FinanceAnalyticsService, ProjectPaymentRuleService],
})
export class FinanceWeeklyModule {}
