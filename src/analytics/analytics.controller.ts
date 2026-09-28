import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsFiltersDto,
  HeatmapQueryDto,
  JobPostsPageQueryDto,
  RecentPostsQueryDto,
  ScannerHealthQueryDto,
} from './dto/analytics-filters.dto';

@ApiExcludeController()
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission('sales_analytics:view')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('scanner-health')
  getScannerHealth(@Query() q: ScannerHealthQueryDto) {
    return this.service.getScannerHealth(q.period ?? 'today');
  }

  @Get('filters-options')
  getFiltersOptions() {
    return this.service.getFiltersOptions();
  }

  @Get('sales-overview')
  getSalesOverview(@Query() q: AnalyticsFiltersDto) {
    return this.service.getSalesOverview(q);
  }

  @Get('opportunity-heatmap')
  getOpportunityHeatmap(@Query() q: HeatmapQueryDto) {
    const { metric, ...filters } = q;
    return this.service.getOpportunityHeatmap(filters, metric ?? 'qualified');
  }

  @Get('recent-high-score-posts')
  getRecentHighScorePosts(@Query() q: RecentPostsQueryDto) {
    const { limit, ...filters } = q;
    return this.service.getRecentHighScorePosts(filters, limit ?? 6);
  }

  @Get('job-posts')
  getJobPostsPage(@Query() q: JobPostsPageQueryDto) {
    const { page, limit, ...filters } = q;
    return this.service.getJobPostsPage(filters, page ?? 1, limit ?? 20);
  }

  @Get('job-posts/:id')
  getJobPostById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.getJobPostById(id);
  }
}
