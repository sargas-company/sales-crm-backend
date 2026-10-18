import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { AiSpendService } from './ai-spend.service';
import { AnalyticsFiltersDto } from './dto/analytics-filters.dto';

@ApiExcludeController()
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission('sales_analytics:view')
@Controller('analytics')
export class AiSpendController {
  constructor(private readonly service: AiSpendService) {}

  @Get('ai-spend')
  getAiSpend(@Query() q: AnalyticsFiltersDto) {
    return this.service.getAiSpend(q);
  }
}
