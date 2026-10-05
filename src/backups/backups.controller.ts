import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { BackupsService } from './backups.service';

/**
 * Backups surface is read-only.
 *
 * Manual backups are triggered from the CLI (`scripts/backup.ts`),
 * never from the browser, so the backend runtime does not need to
 * hold the backup B2 credentials just to serve a UI button. The
 * list/details/summary endpoints below are gated by `backups:view`
 * which is Owner-only in the system role matrix.
 */
@ApiTags('Backups')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('backups')
export class BackupsController {
  constructor(private readonly svc: BackupsService) {}

  @Get()
  @RequirePermission('backups:view')
  list(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.svc.list(
      page ? Number(page) : 1,
      limit ? Number(limit) : 25,
    );
  }

  @Get('summary')
  @RequirePermission('backups:view')
  summary() {
    return this.svc.summary();
  }

  @Get(':id')
  @RequirePermission('backups:view')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }
}
