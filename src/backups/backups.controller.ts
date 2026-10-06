import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

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

  /**
   * Issue a short-lived (120s) B2 signed URL for the backup artifact.
   * The CRM access token stays in the Authorization header; the
   * signed URL in the response body carries its own object-scoped
   * token and expires shortly after issue. Every call is written to
   * the audit stream regardless of outcome.
   */
  @Get(':id/download')
  @RequirePermission('backups:download')
  @ApiOperation({ summary: 'Get a short-lived signed URL to download the backup artifact.' })
  @ApiResponse({
    status: 200,
    description: 'Returns { url, expiresAt, fileName }',
  })
  @ApiResponse({ status: 400, description: 'Run has no artifact to download' })
  @ApiResponse({ status: 404, description: 'Backup run not found' })
  download(@Param('id') id: string, @Request() req) {
    const u = req.user ?? {};
    return this.svc.getDownloadUrl(
      id,
      {
        userId: u.id,
        email: u.email ?? null,
        name:
          [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || null,
      },
      {
        ip: req.ip ?? null,
        userAgent: req.get?.('user-agent') ?? null,
        requestId: req.get?.('x-request-id') ?? null,
      },
    );
  }
}
