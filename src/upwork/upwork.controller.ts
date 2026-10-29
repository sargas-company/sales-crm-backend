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
  BulkAddUpworkReferenceDataDto,
  BulkDeleteUpworkReferenceDataDto,
  CreateUpworkReferenceDataDto,
  ListUpworkReferenceDataDto,
  UpdateUpworkReferenceDataDto,
} from './dto/upwork-reference-data.dto';
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
import { UpworkReferenceDataService } from './upwork-reference-data.service';
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
    private readonly refs: UpworkReferenceDataService,
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

  /* ── Reference data ────────────────────────────────────────────── */

  @Get('reference-data')
  @RequirePermission('upwork:view')
  listReferences(@Query() query: ListUpworkReferenceDataDto) {
    return this.refs.list(query);
  }

  @Get('reference-data/:id')
  @RequirePermission('upwork:view')
  getReference(@Param('id') id: string) {
    return this.refs.findOne(id);
  }

  @Post('reference-data')
  @RequirePermission('upwork:create')
  @HttpCode(HttpStatus.CREATED)
  createReference(
    @Body() dto: CreateUpworkReferenceDataDto,
    @Req() req: ReqWithUser,
  ) {
    return this.refs.create(dto, req.user.id);
  }

  @Post('reference-data/bulk-add')
  @RequirePermission('upwork:create')
  @ApiOperation({ summary: 'Bulk add N values under shared category/profile/date' })
  @HttpCode(HttpStatus.CREATED)
  bulkAddReferences(
    @Body() dto: BulkAddUpworkReferenceDataDto,
    @Req() req: ReqWithUser,
  ) {
    return this.refs.bulkAdd(dto, req.user.id);
  }

  @Patch('reference-data/:id')
  @RequirePermission('upwork:update')
  updateReference(
    @Param('id') id: string,
    @Body() dto: UpdateUpworkReferenceDataDto,
    @Req() req: ReqWithUser,
  ) {
    return this.refs.update(id, dto, req.user.id);
  }

  @Post('reference-data/:id/archive')
  @RequirePermission('upwork:update')
  archiveReference(@Param('id') id: string, @Req() req: ReqWithUser) {
    return this.refs.archive(id, req.user.id);
  }

  @Post('reference-data/bulk-delete')
  @RequirePermission('upwork:delete')
  @HttpCode(HttpStatus.OK)
  bulkDeleteReferences(
    @Body() dto: BulkDeleteUpworkReferenceDataDto,
    @Req() req: ReqWithUser,
  ) {
    return this.refs.bulkDelete(dto, req.user.id);
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
