import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProjectStatus } from '@prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { ProjectAnalyticsService } from './project-analytics.service';

type Aggregation = 'week' | 'month';

@ApiTags('ProjectAnalytics')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('analytics/projects')
export class ProjectAnalyticsController {
  constructor(private readonly svc: ProjectAnalyticsService) {}

  @Get('overview')
  @RequirePermission('project_analytics:view')
  @ApiOperation({
    summary:
      'Project analytics overview (KPI + hours series + reports series + status timeline + workload)',
  })
  overview(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('projectId') projectId?: string,
    @Query('status') status?: ProjectStatus,
    @Query('aggregation') aggregation?: Aggregation,
  ) {
    return this.svc.overview({ from, to, projectId, status, aggregation });
  }
}
