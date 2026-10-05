import { Module } from '@nestjs/common';

import { ProjectAnalyticsController } from './project-analytics.controller';
import { ProjectAnalyticsService } from './project-analytics.service';

@Module({
  controllers: [ProjectAnalyticsController],
  providers: [ProjectAnalyticsService],
  exports: [ProjectAnalyticsService],
})
export class ProjectAnalyticsModule {}
