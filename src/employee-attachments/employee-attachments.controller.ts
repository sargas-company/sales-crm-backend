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
import { EmployeeAttachmentsService } from './employee-attachments.service';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

@ApiTags('Employee Attachments')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('employees/:id/attachments')
export class EmployeeAttachmentsController {
  constructor(private readonly svc: EmployeeAttachmentsService) {}

  @Get()
  @RequirePermission('employees:attachments:view')
  @ApiOperation({ summary: 'List files attached to an employee.' })
  list(@Param('id') employeeId: string) {
    return this.svc.list(employeeId);
  }

  @Post()
  @RequirePermission('employees:attachments:create')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  @ApiOperation({ summary: 'Upload a new attachment (max 50 MB).' })
  upload(
    @Param('id') employeeId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.upload({
      employeeId,
      file,
      actorUserId: req.user.id,
    });
  }

  @Get(':attachmentId/download-url')
  @RequirePermission('employees:attachments:view')
  @ApiOperation({
    summary:
      'Issue a short-lived signed download URL from Backblaze (60s TTL by default).',
  })
  downloadUrl(
    @Param('id') employeeId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.getDownloadUrl(employeeId, attachmentId, req.user.id);
  }

  @Delete(':attachmentId')
  @RequirePermission('employees:attachments:delete')
  @ApiOperation({
    summary:
      'Remove an attachment: deletes the DB row AND the Backblaze object.',
  })
  remove(
    @Param('id') employeeId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    return this.svc.remove(employeeId, attachmentId, req.user.id);
  }
}
