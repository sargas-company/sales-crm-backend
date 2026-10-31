import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';

import {
  CreateUpworkProfileDto,
  UpdateUpworkProfileDto,
} from './dto/upwork-profile.dto';
import {
  CreateUpworkChangeLogDto,
  ListUpworkChangeLogDto,
  UpdateUpworkChangeLogDto,
} from './dto/upwork-change-log.dto';
import {
  CreateUpworkSnapshotDto,
  ListUpworkSnapshotsDto,
  UpdateUpworkSnapshotDto,
} from './dto/upwork-metrics.dto';

import { UpworkProfileService } from './upwork-profile.service';
import { UpworkChangeLogService } from './upwork-change-log.service';
import { UpworkMetricsService } from './upwork-metrics.service';
import { UpworkRemindersService } from './upwork-reminders.service';
import { UpworkAnalyticsService } from './upwork-analytics.service';

type ReqWithUser = { user: { id: string } };

@ApiTags('Upwork')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('upwork')
export class UpworkController {
  constructor(
    private readonly profiles: UpworkProfileService,
    private readonly changeLog: UpworkChangeLogService,
    private readonly metrics: UpworkMetricsService,
    private readonly reminders: UpworkRemindersService,
    private readonly analytics: UpworkAnalyticsService,
  ) {}

  /* ── Profiles ──────────────────────────────────────────────────── */

  @Get('profiles')
  @RequirePermission('upwork:view')
  listProfiles() {
    return this.profiles.list();
  }

  @Get('profiles/:id')
  @RequirePermission('upwork:view')
  getProfile(@Param('id') id: string) {
    return this.profiles.findOne(id);
  }

  @Post('profiles')
  @RequirePermission('upwork:create')
  @HttpCode(HttpStatus.CREATED)
  createProfile(@Body() dto: CreateUpworkProfileDto, @Req() req: ReqWithUser) {
    return this.profiles.create(dto, req.user.id);
  }

  @Patch('profiles/:id')
  @RequirePermission('upwork:update')
  updateProfile(
    @Param('id') id: string,
    @Body() dto: UpdateUpworkProfileDto,
    @Req() req: ReqWithUser,
  ) {
    return this.profiles.update(id, dto, req.user.id);
  }

  @Delete('profiles/:id')
  @RequirePermission('upwork:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeProfile(@Param('id') id: string, @Req() req: ReqWithUser) {
    return this.profiles.remove(id, req.user.id);
  }

  /* ── Change log ────────────────────────────────────────────────── */

  @Get('change-log')
  @RequirePermission('upwork:view')
  listChangeLog(@Query() query: ListUpworkChangeLogDto) {
    return this.changeLog.list(query);
  }

  @Get('change-log/:id')
  @RequirePermission('upwork:view')
  getChangeLog(@Param('id') id: string) {
    return this.changeLog.findOne(id);
  }

  @Post('change-log')
  @RequirePermission('upwork:create')
  @HttpCode(HttpStatus.CREATED)
  createChangeLog(
    @Body() dto: CreateUpworkChangeLogDto,
    @Req() req: ReqWithUser,
  ) {
    return this.changeLog.create(dto, req.user.id);
  }

  @Patch('change-log/:id')
  @RequirePermission('upwork:update')
  updateChangeLog(
    @Param('id') id: string,
    @Body() dto: UpdateUpworkChangeLogDto,
    @Req() req: ReqWithUser,
  ) {
    return this.changeLog.update(id, dto, req.user.id);
  }

  @Delete('change-log/:id')
  @RequirePermission('upwork:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeChangeLog(@Param('id') id: string, @Req() req: ReqWithUser) {
    return this.changeLog.remove(id, req.user.id);
  }

  /* ── Metrics snapshots ─────────────────────────────────────────── */

  @Get('snapshots')
  @RequirePermission('upwork_analytics:view')
  listSnapshots(@Query() query: ListUpworkSnapshotsDto) {
    return this.metrics.list(query);
  }

  @Get('snapshots/:id')
  @RequirePermission('upwork_analytics:view')
  getSnapshot(@Param('id') id: string) {
    return this.metrics.findOne(id);
  }

  @Post('snapshots')
  @RequirePermission('upwork:create')
  @HttpCode(HttpStatus.CREATED)
  createSnapshot(
    @Body() dto: CreateUpworkSnapshotDto,
    @Req() req: ReqWithUser,
  ) {
    return this.metrics.create(dto, req.user.id);
  }

  @Patch('snapshots/:id')
  @RequirePermission('upwork:update')
  updateSnapshot(
    @Param('id') id: string,
    @Body() dto: UpdateUpworkSnapshotDto,
    @Req() req: ReqWithUser,
  ) {
    return this.metrics.update(id, dto, req.user.id);
  }

  @Delete('snapshots/:id')
  @RequirePermission('upwork:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeSnapshot(@Param('id') id: string, @Req() req: ReqWithUser) {
    return this.metrics.remove(id, req.user.id);
  }

  /* ── Reminders ────────────────────────────────────────────────── */

  @Get('reminders')
  @RequirePermission('upwork:view')
  getReminders(@Query('profileId') profileId: string) {
    return this.reminders.forProfile(profileId);
  }

  /* ── Analytics ────────────────────────────────────────────────── */

  @Get('analytics')
  @RequirePermission('upwork_analytics:view')
  getAnalytics(
    @Query('profileId') profileId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.summary({ profileId, from, to });
  }
}
