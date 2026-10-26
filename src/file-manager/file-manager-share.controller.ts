import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';

import {
  CreateDirectShareDto,
  CreateInviteDto,
  ShareResourceType,
  UpdateShareDto,
} from './dto/share.dto';
import { FileManagerShareService } from './file-manager-share.service';

/* Admin surface for managing shares, invites, and portal users.
 * All routes require `file_manager:manage` — the same permission as
 * existing File Manager mutating endpoints. */
@ApiTags('File Manager — Shares')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, AdminOnlyGuard, PermissionGuard)
@Controller('file-manager')
export class FileManagerShareController {
  constructor(private readonly svc: FileManagerShareService) {}

  /* ── Shares ──────────────────────────────────────────────────── */

  @Post('shares')
  @RequirePermission('file_manager:manage')
  @ApiOperation({
    summary:
      'Grant a share directly to an existing portal user (no invite). Idempotent — overwrites permissions if the share exists.',
  })
  createShare(
    @Body() dto: CreateDirectShareDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.createDirectShare(dto, req.user.id);
  }

  @Patch('shares/:id')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Edit permissions on an existing share.' })
  updateShare(
    @Param('id') id: string,
    @Body() dto: UpdateShareDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.updateShare(id, dto, req.user.id);
  }

  @Delete('shares/:id')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Revoke a share.' })
  revokeShare(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.revokeShare(id, req.user.id);
  }

  @Get('shares')
  @RequirePermission('file_manager:manage')
  @ApiOperation({
    summary:
      'List shares on a given resource. Query: ?resourceType=FOLDER|FILE&resourceId=<uuid>',
  })
  listSharesOnResource(
    @Query('resourceType') resourceType: ShareResourceType,
    @Query('resourceId') resourceId: string,
  ) {
    return this.svc.listSharesOnResource(resourceType, resourceId);
  }

  /* ── Portal users ────────────────────────────────────────────── */

  @Get('portal-users')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'List all portal users.' })
  listPortalUsers() {
    return this.svc.listPortalUsers();
  }

  @Get('portal-users/:id')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Portal user detail incl. their shares.' })
  getPortalUser(@Param('id') id: string) {
    return this.svc.getPortalUser(id);
  }

  @Post('portal-users/:id/terminate')
  @RequirePermission('file_manager:manage')
  @ApiOperation({
    summary:
      'Terminate a portal user (sets active=false). Shares stay in DB; reactivation restores access.',
  })
  terminatePortalUser(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.terminatePortalUser(id, req.user.id);
  }

  @Post('portal-users/:id/reactivate')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Reactivate a terminated portal user.' })
  reactivatePortalUser(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.reactivatePortalUser(id, req.user.id);
  }

  /* ── Invites ─────────────────────────────────────────────────── */

  @Post('invites')
  @RequirePermission('file_manager:manage')
  @ApiOperation({
    summary:
      'Create a single-use invite link bundling N shares. Returns token + full URL.',
  })
  createInvite(
    @Body() dto: CreateInviteDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.createInvite(dto, req.user.id);
  }

  @Delete('invites/:id')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Revoke an unused invite.' })
  revokeInvite(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.revokeInvite(id, req.user.id);
  }

  @Get('invites')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'List recent invites.' })
  listInvites() {
    return this.svc.listInvites();
  }
}
