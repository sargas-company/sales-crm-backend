import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { CompensationAnalyticsService } from './compensation-analytics.service';

class OverviewQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;
}

const currentYear = () => new Date().getUTCFullYear();
const currentMonth = () => new Date().getUTCMonth() + 1;

@ApiTags('CompensationAnalytics')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('compensation-analytics')
export class CompensationAnalyticsController {
  constructor(private readonly svc: CompensationAnalyticsService) {}

  @Get('overview')
  @RequirePermission('compensation_analytics:view')
  @ApiOperation({ summary: 'Compensation analytics overview for a month' })
  overview(@Query() dto: OverviewQueryDto) {
    return this.svc.overview(
      dto.year ?? currentYear(),
      dto.month ?? currentMonth(),
    );
  }
}
