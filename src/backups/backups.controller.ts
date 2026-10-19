import {
  Controller,
  Get,
  Param,
  Post,
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
 * Backups surface. List/details/summary remain read-only.
 *
 * As of 2026-10-19 the backend also exposes a `POST /backups/trigger`
 * endpoint — a human-triggered backup from the Backups UI, firing the
 * same shared `runBackup` path that `scripts/backup.ts` uses under
 * cron. The Nest process must have the backup B2 credentials in its
 * env for this to work (same `.env` as the cron script, read by
 * `dotenv.config()` in `main.ts`). Trigger is Owner-only
 * (`backups:create`); view/list/download are gated by `backups:view`
 * (admin_manager + Owner) or `backups:download` (Owner-only).
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
   * Human-triggered backup from the Backups UI. Fires `runBackup`
   * through the same shared runner cron uses, with
   * `type=MANUAL triggeredBy='manual-ui'`. Returns immediately —
   * the caller polls `GET /backups` to watch the new row.
   *
   * Concurrency: a RUNNING row younger than 10 min returns 409 so
   * double-clicks don't translate into back-to-back Discord
   * `pg advisory lock held` failure pings.
   */
  @Post('trigger')
  @RequirePermission('backups:create')
  @ApiOperation({ summary: 'Trigger a manual backup from the UI.' })
  @ApiResponse({
    status: 201,
    description: 'Returns { started: true, triggeredAt }',
  })
  @ApiResponse({ status: 409, description: 'Another backup is already running' })
  trigger(@Request() req) {
    const u = req.user ?? {};
    return this.svc.trigger(
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
