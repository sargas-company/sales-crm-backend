import { Module } from '@nestjs/common';

import { ProjectReportController } from './project-report.controller';
import { ProjectReportService } from './project-report.service';

@Module({
  controllers: [ProjectReportController],
  providers: [ProjectReportService],
  exports: [ProjectReportService],
})
export class ProjectReportModule {}
