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

import { ForbiddenException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { FileManagerAccessService } from './file-manager-access.service';
import { FileManagerService } from './file-manager.service';
import { UploadSessionService } from './upload-session.service';
import { CreateFolderDto } from './dto/create-folder.dto';
import { RenameFolderDto } from './dto/rename-folder.dto';
import { MoveNodeDto } from './dto/move-node.dto';
import { RenameFileDto } from './dto/rename-file.dto';
import { InitUploadDto } from './dto/init-upload.dto';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/* Chunk upload cap — one 8 MiB chunk, with 2 MiB headroom for the
 * multipart envelope. The resumable path above is where real large
 * files flow; this cap is per-part only. */
/* Multer per-part cap. Must stay above CHUNK_SIZE in
 * upload-session.service.ts (currently 16 MiB) with headroom for
 * multipart/form-data boundary and headers. */
const MAX_PART_BYTES = 20 * 1024 * 1024;

@ApiTags('File Manager')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('file-manager')
export class FileManagerController {
  constructor(
    private readonly svc: FileManagerService,
    private readonly uploads: UploadSessionService,
    private readonly access: FileManagerAccessService,
    private readonly prisma: PrismaService,
  ) {}

  /* Looks up the authenticated user once and tells callers whether
   * the request belongs to a portal (external worker) user and —
   * for portal users — their computed access scope. Called at the
   * start of every endpoint that must behave differently for admins
   * vs portal workers. */
  private async context(actorUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { isPortalUser: true },
    });
    if (!user?.isPortalUser) return { isPortal: false as const };
    const scope = await this.access.computeScope(actorUserId);
    return { isPortal: true as const, scope };
  }

  /* ── Reads ──────────────────────────────────────────────────────── */

  @Get('folders/root')
  @RequirePermission('file_manager:view')
  @ApiOperation({ summary: 'List root folders and files.' })
  async listRoot(@Req() req: Request & { user: AuthUser }) {
    const ctx = await this.context(req.user.id);
    if (!ctx.isPortal) return this.svc.listFolder(null);
    /* Portal user: root view = all top-level shared resources,
     * flattened (regardless of actual tree position). Files shared
     * directly land here too. */
    return this.svc.listSharedTopLevel(
      Array.from(ctx.scope.topLevelFolderIds),
      Array.from(ctx.scope.topLevelFileIds),
    );
  }

  @Get('tree')
  @RequirePermission('file_manager:view')
  @ApiOperation({ summary: 'Full nested folder tree (for the sidebar).' })
  async listTree(@Req() req: Request & { user: AuthUser }) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) {
      /* Portal users don't use the global tree view — they only see
       * flat root + navigate into shared folders. Return empty. */
      return { roots: [], rootFileCount: 0 };
    }
    return this.svc.listTree();
  }

  @Get('stats')
  @RequirePermission('file_manager:view')
  @ApiOperation({ summary: 'Storage usage grouped by broad MIME category.' })
  async stats(@Req() req: Request & { user: AuthUser }) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) {
      return {
        total: 0,
        count: 0,
        buckets: { images: 0, documents: 0, videos: 0, audio: 0, other: 0 },
      };
    }
    return this.svc.getStorageStats();
  }

  @Get('folders/:id')
  @RequirePermission('file_manager:view')
  @ApiOperation({ summary: 'List a folder (child folders + files + breadcrumbs).' })
  async listFolder(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) {
      if (!this.access.canSeeFolder(ctx.scope, id)) {
        throw new ForbiddenException('No access to this folder');
      }
      return this.svc.listFolderFiltered(id, ctx.scope.openFolderIds);
    }
    return this.svc.listFolder(id);
  }

  /* ── Folders ────────────────────────────────────────────────────── */

  @Post('folders')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Create a folder (optionally under a parent).' })
  async createFolder(
    @Body() dto: CreateFolderDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) {
      /* Portal workers may only create subfolders inside a folder
       * they have `canCreateSubfolders` on (direct or recursive). */
      if (!dto.parentId) {
        throw new ForbiddenException('Portal users cannot create root folders');
      }
      if (!this.access.canCreateSubfolderIn(ctx.scope, dto.parentId)) {
        throw new ForbiddenException(
          'No permission to create folders in this folder',
        );
      }
    }
    return this.svc.createFolder(dto.name, dto.parentId, req.user.id);
  }

  @Patch('folders/:id/rename')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Rename a folder.' })
  async renameFolder(
    @Param('id') id: string,
    @Body() dto: RenameFolderDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) throw new ForbiddenException('Portal users cannot rename');
    return this.svc.renameFolder(id, dto.name, req.user.id);
  }

  @Patch('folders/:id/move')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Move a folder under another parent (or to root).' })
  async moveFolder(
    @Param('id') id: string,
    @Body() dto: MoveNodeDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) throw new ForbiddenException('Portal users cannot move');
    return this.svc.moveFolder(id, dto.targetFolderId ?? null, req.user.id);
  }

  @Delete('folders/:id')
  @RequirePermission('file_manager:manage')
  @ApiOperation({
    summary:
      'Delete a folder and cascade all descendants (DB rows + B2 objects).',
  })
  async deleteFolder(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) throw new ForbiddenException('Portal users cannot delete folders');
    return this.svc.deleteFolder(id, req.user.id);
  }

  /* ── Files ──────────────────────────────────────────────────────── */

  @Post('files')
  @RequirePermission('file_manager:manage')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  @ApiOperation({ summary: 'Upload a file into a folder (max 100 MB).' })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Query('folderId') folderId: string | undefined,
    @Req() req: Request & { user: AuthUser },
  ) {
    const targetFolderId =
      folderId && folderId !== 'null' ? folderId : null;
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) {
      if (!targetFolderId) {
        throw new ForbiddenException(
          'Portal users cannot upload to the root — only inside shared folders',
        );
      }
      if (!this.access.canUploadInto(ctx.scope, targetFolderId)) {
        throw new ForbiddenException('No upload permission in this folder');
      }
    }
    return this.svc.uploadFile({
      folderId: targetFolderId,
      file,
      actorUserId: req.user.id,
    });
  }

  /* ── Resumable uploads ──────────────────────────────────────────── */

  @Post('uploads')
  @RequirePermission('file_manager:manage')
  @ApiOperation({
    summary:
      'Init a resumable upload session (B2 large-file multipart). Returns id, chunkSize, totalParts.',
  })
  async initUpload(
    @Body() dto: InitUploadDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) {
      if (!dto.folderId) {
        throw new ForbiddenException(
          'Portal users cannot upload to the root — only inside shared folders',
        );
      }
      if (!this.access.canUploadInto(ctx.scope, dto.folderId)) {
        throw new ForbiddenException('No upload permission in this folder');
      }
    }
    return this.uploads.init(dto, req.user.id);
  }

  @Post('uploads/:id/parts/:index')
  @RequirePermission('file_manager:manage')
  @UseInterceptors(
    FileInterceptor('part', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_PART_BYTES },
    }),
  )
  @ApiOperation({
    summary:
      'Upload one chunk of a resumable session. Part index is 1-based and must match the session totalParts range.',
  })
  uploadPart(
    @Param('id') id: string,
    @Param('index') index: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: AuthUser },
  ) {
    if (!file) throw new Error('part is required');
    return this.uploads.uploadPart(id, Number(index), file.buffer, req.user.id);
  }

  @Post('uploads/:id/finalize')
  @RequirePermission('file_manager:manage')
  @ApiOperation({
    summary:
      'Finish a resumable session: b2_finish_large_file + create FileManagerFile row.',
  })
  finalizeUpload(@Param('id') id: string, @Req() req: Request & { user: AuthUser }) {
    return this.uploads.finalize(id, req.user.id);
  }

  @Delete('uploads/:id')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Cancel a resumable session (cancel on B2 + mark aborted).' })
  cancelUpload(@Param('id') id: string, @Req() req: Request & { user: AuthUser }) {
    return this.uploads.cancel(id, req.user.id);
  }

  @Get('uploads/mine')
  @RequirePermission('file_manager:manage')
  @ApiOperation({
    summary:
      'List open resumable sessions for the current user — used by the frontend to restore the tray after page reload.',
  })
  listMyUploads(@Req() req: Request & { user: AuthUser }) {
    return this.uploads.listMine(req.user.id);
  }

  @Get('uploads/:id')
  @RequirePermission('file_manager:manage')
  @ApiOperation({
    summary:
      'Current state of a resumable session: partsReceived + status. 404 = session gone (expired/aborted/wrong user).',
  })
  getUpload(@Param('id') id: string, @Req() req: Request & { user: AuthUser }) {
    return this.uploads.get(id, req.user.id);
  }

  @Patch('files/:id/rename')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Rename a file.' })
  async renameFile(
    @Param('id') id: string,
    @Body() dto: RenameFileDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) {
      throw new ForbiddenException('Portal users cannot rename files');
    }
    return this.svc.renameFile(id, dto.name, req.user.id);
  }

  @Patch('files/:id/move')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Move a file into another folder (or to root).' })
  async moveFile(
    @Param('id') id: string,
    @Body() dto: MoveNodeDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) {
      throw new ForbiddenException('Portal users cannot move files');
    }
    return this.svc.moveFile(id, dto.targetFolderId ?? null, req.user.id);
  }

  @Delete('files/:id')
  @RequirePermission('file_manager:manage')
  @ApiOperation({ summary: 'Delete a file (DB row + B2 object).' })
  async deleteFile(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    const ctx = await this.context(req.user.id);
    if (ctx.isPortal) {
      /* Portal user may delete only OWN files uploaded within the
       * last 24 hours (owner-approved rule). */
      const file = await this.prisma.fileManagerFile.findUnique({
        where: { id },
        select: { uploadedById: true, createdAt: true },
      });
      if (!file) throw new ForbiddenException('File not found');
      if (file.uploadedById !== req.user.id) {
        throw new ForbiddenException('You can only delete your own files');
      }
      const ageMs = Date.now() - file.createdAt.getTime();
      if (ageMs > 24 * 60 * 60 * 1000) {
        throw new ForbiddenException(
          'You can delete your own files only within 24 hours of upload',
        );
      }
    }
    return this.svc.deleteFile(id, req.user.id);
  }

  @Get('files/:id/download-url')
  @RequirePermission('file_manager:view')
  @ApiOperation({
    summary: 'Issue a short-lived signed download URL (5m TTL default).',
  })
  async downloadUrl(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    await this.ensurePortalCanAccessFile(req.user.id, id, 'download');
    return this.svc.getDownloadUrl(id, req.user.id);
  }

  @Get('files/:id/preview-url')
  @RequirePermission('file_manager:view')
  @ApiOperation({
    summary:
      'Short-lived signed URL for inline preview (image / PDF viewer).',
  })
  async previewUrl(
    @Param('id') id: string,
    @Req() req: Request & { user: AuthUser },
  ) {
    await this.ensurePortalCanAccessFile(req.user.id, id, 'download');
    return this.svc.getInlineUrl(id, req.user.id);
  }

  /* Shared helper for portal file-access checks. For admins it's a
   * no-op; for portal users it verifies that:
   *   - the file sits inside an accessible folder (or is directly
   *     shared), AND
   *   - the user has `canDownload` on that scope.
   * Throws ForbiddenException otherwise. */
  private async ensurePortalCanAccessFile(
    actorUserId: string,
    fileId: string,
    _permission: 'download',
  ): Promise<void> {
    const ctx = await this.context(actorUserId);
    if (!ctx.isPortal) return;
    const file = await this.prisma.fileManagerFile.findUnique({
      where: { id: fileId },
      select: { id: true, folderId: true },
    });
    if (!file) throw new ForbiddenException('File not found');
    if (!this.access.canSeeFile(ctx.scope, file.id, file.folderId)) {
      throw new ForbiddenException('No access to this file');
    }
    if (!this.access.canDownloadFile(ctx.scope, file.id, file.folderId)) {
      throw new ForbiddenException('No download permission on this file');
    }
  }
}
