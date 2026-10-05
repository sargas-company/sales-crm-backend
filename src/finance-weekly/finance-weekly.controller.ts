import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';

import { FinanceWeeklyService } from './finance-weekly.service';
import { FinanceAnalyticsService } from './finance-analytics.service';
import { UpsertWeeklyEntryDto } from './dto/upsert-weekly-entry.dto';
import { ListEntriesQueryDto } from './dto/list-entries.dto';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

@ApiTags('FinanceWeekly')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('finances')
export class FinanceWeeklyController {
  constructor(
    private readonly svc: FinanceWeeklyService,
    private readonly analytics: FinanceAnalyticsService,
  ) {}

  @Get('fiscal-months')
  @RequirePermission('finances_weekly:view')
  @ApiOperation({ summary: 'List fiscal months (optionally filtered by year)' })
  listFiscalMonths(
    @Query(
      'year',
      new ParseIntPipe({ optional: true }) as unknown as ParseIntPipe,
    )
    year?: number,
  ) {
    return this.svc.listFiscalMonths(year);
  }

  @Get('months/current')
  @RequirePermission('finances_weekly:view')
  @ApiOperation({ summary: 'Get the fiscal month containing today (or nearest past)' })
  current() {
    return this.svc.getCurrentFiscalMonth();
  }

  @Get('months/:id/overview')
  @RequirePermission('finances_weekly:view')
  @ApiOperation({ summary: 'Fiscal month overview: grid, KPI, predictions' })
  overview(@Param('id') id: string) {
    return this.svc.overview(id);
  }

  @Get('months/:id/list')
  @RequirePermission('finances_weekly:view')
  @ApiOperation({ summary: 'Flat list of entries for a fiscal month' })
  listFlat(@Param('id') id: string) {
    return this.svc.listFlat(id);
  }

  @Get('entries')
  @RequirePermission('finances_weekly:view')
  @ApiOperation({
    summary: 'Cross-month registry: paginated entries across a date range',
  })
  listEntries(@Query() query: ListEntriesQueryDto) {
    return this.svc.listEntries(query);
  }

  @Get('projects/summary')
  @RequirePermission('finances_weekly:view')
  @ApiOperation({ summary: 'Compact project list for registry filters' })
  projectsSummary() {
    return this.svc.listProjectsSummary();
  }

  @Get('analytics')
  @RequirePermission('finances_weekly:view')
  @ApiOperation({
    summary:
      'Finance analytics — snapshot, monthly history, revenue by project / client, pipeline breakdown, year overview',
  })
  analyticsSummary(@Query() query: AnalyticsQueryDto) {
    return this.analytics.summary(query);
  }

  @Patch('weekly-entries/upsert')
  @RequirePermission('finances_weekly:edit')
  @ApiOperation({ summary: 'Upsert a weekly entry by (fiscalWeekId, projectId)' })
  upsertEntry(@Body() dto: UpsertWeeklyEntryDto, @Request() req) {
    const userId = req?.user?.id ?? req?.user?.sub ?? null;
    return this.svc.upsertEntry(dto, userId);
  }

  @Delete('weekly-entries/:id')
  @RequirePermission('finances_weekly:edit')
  @ApiOperation({ summary: 'Delete a weekly entry' })
  deleteEntry(@Param('id') id: string) {
    return this.svc.deleteEntry(id);
  }
}
