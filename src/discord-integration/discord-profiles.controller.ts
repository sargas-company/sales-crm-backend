import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DiscordProfileName } from '@prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { DiscordAdminService, type PreviewJob } from './discord-admin.service';
import { DiscordProfilesService } from './discord-profiles.service';
import { UpdateDiscordProfileDto } from './dto/update-profile.dto';

const ALLOWED_PREVIEW_JOBS: PreviewJob[] = [
  'REPORT',
  'LATE_REPORT',
  'BIRTHDAY',
  'ABSENCES',
  'REMINDER_18',
  'DAILY_DIGEST_19',
  'WEEKLY_DIGEST',
];

/**
 * Owner-only (`discord_integration:*`) HTTP surface for the Discord
 * integration page. Secrets never cross this boundary — only the
 * `envStatus` flags do.
 */
@ApiTags('Discord Integration')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('discord-integration')
export class DiscordProfilesController {
  constructor(
    private readonly svc: DiscordProfilesService,
    private readonly admin: DiscordAdminService,
  ) {}

  @Get('profiles')
  @RequirePermission('discord_integration:view')
  list() {
    return this.svc.listAll();
  }

  @Get('profiles/:name')
  @RequirePermission('discord_integration:view')
  getOne(@Param('name') name: DiscordProfileName) {
    return this.svc.getByName(name);
  }

  @Patch('profiles/:name')
  @RequirePermission('discord_integration:configure')
  update(
    @Param('name') name: DiscordProfileName,
    @Body() dto: UpdateDiscordProfileDto,
  ) {
    return this.svc.update(name, dto);
  }

  @Post('profiles/:name/activate')
  @RequirePermission('discord_integration:activate_profile')
  activate(@Param('name') name: DiscordProfileName) {
    return this.svc.activate(name);
  }

  @Post('profiles/:name/verify')
  @RequirePermission('discord_integration:view')
  verify(@Param('name') name: DiscordProfileName) {
    return this.admin.verify(name);
  }

  @Post('profiles/:name/send-test')
  @RequirePermission('discord_integration:send_test')
  sendTest(@Param('name') name: DiscordProfileName) {
    return this.admin.sendTest(name);
  }

  @Post('profiles/:name/send-preview')
  @RequirePermission('discord_integration:send_test')
  sendPreview(
    @Param('name') name: DiscordProfileName,
    @Query('job') job: PreviewJob,
  ) {
    if (!job || !ALLOWED_PREVIEW_JOBS.includes(job)) {
      throw new BadRequestException(
        `job must be one of ${ALLOWED_PREVIEW_JOBS.join(', ')}`,
      );
    }
    return this.admin.sendPreview(name, job);
  }
}
