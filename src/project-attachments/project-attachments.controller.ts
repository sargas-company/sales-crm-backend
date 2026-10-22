import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { Request } from 'express';

import { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { ProjectAttachmentsService } from './project-attachments.service';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

@ApiTags('Project Attachments')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('projects/:id/attachments')
export class ProjectAttachmentsController {
  constructor(private readonly svc: ProjectAttachmentsService) {}

  @Get()
  @RequirePermission('projects:attachments:view')
  @ApiOperation({ summary: 'List files attached to a project.' })
  list(@Param('id') projectId: string) {
    return this.svc.list(projectId);
  }

  @Post()
  @RequirePermission('projects:attachments:create')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  @ApiOperation({ summary: 'Upload a new attachment (max 50 MB).' })
  upload(
    @Param('id') projectId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.upload({
      projectId,
      file,
      actorUserId: req.user.id,
    });
  }

  @Get(':attachmentId/download-url')
  @RequirePermission('projects:attachments:view')
  @ApiOperation({
    summary:
      'Issue a short-lived signed download URL from Backblaze (60s TTL by default).',
  })
  downloadUrl(
    @Param('id') projectId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.getDownloadUrl(projectId, attachmentId, req.user.id);
  }

  @Delete(':attachmentId')
  @RequirePermission('projects:attachments:delete')
  @ApiOperation({
    summary:
      'Remove an attachment: deletes the DB row AND the Backblaze object.',
  })
  remove(
    @Param('id') projectId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.remove(projectId, attachmentId, req.user.id);
  }
}
