import { Module } from '@nestjs/common';

import { DiscordIntegrationModule } from '../discord-integration/discord-integration.module';
import { ProjectReportController } from './project-report.controller';
import { ProjectReportService } from './project-report.service';

@Module({
  imports: [DiscordIntegrationModule],
  controllers: [ProjectReportController],
  providers: [ProjectReportService],
  exports: [ProjectReportService],
})
export class ProjectReportModule {}
