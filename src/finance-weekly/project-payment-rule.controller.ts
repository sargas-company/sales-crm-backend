import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';

import { ProjectPaymentRuleService } from './project-payment-rule.service';
import { UpsertPaymentRuleDto } from './dto/upsert-payment-rule.dto';

@ApiTags('ProjectPaymentRule')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('projects/:projectId/payment-rules')
export class ProjectPaymentRuleController {
  constructor(private readonly svc: ProjectPaymentRuleService) {}

  @Get()
  @RequirePermission('finances_weekly:view')
  @ApiOperation({ summary: 'List payment rule history for a project' })
  list(@Param('projectId') projectId: string) {
    return this.svc.list(projectId);
  }

  @Get('current')
  @RequirePermission('finances_weekly:view')
  @ApiOperation({ summary: 'Get the currently effective payment rule' })
  current(@Param('projectId') projectId: string) {
    return this.svc.currentForProject(projectId);
  }

  @Post()
  @RequirePermission('finances_weekly:edit')
  @ApiOperation({
    summary: 'Create a new payment rule (history is preserved)',
  })
  create(
    @Param('projectId') projectId: string,
    @Body() dto: UpsertPaymentRuleDto,
  ) {
    return this.svc.createOrReplace(projectId, dto);
  }
}
