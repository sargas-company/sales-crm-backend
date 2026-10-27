import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditResult } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { StorageBucket } from '../storage/storage.types';
import { AuditEventService } from '../audit-event/audit-event.service';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

interface UploadInput {
  folderId: string | null;
  file: Express.Multer.File;
  actorUserId: string;
}

export interface FileManagerTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  fileCount: number;
  childFolderCount: number;
  children: FileManagerTreeNode[];
}

/*
 * Standalone corporate file manager — no FK to Project / Client /
 * Employee / anything else. Nested folder tree in Postgres; files
 * live in the FILE_MANAGER B2 bucket. Access gate is enforced in
 * the controller via @RequirePermission('file_manager:view' | ':manage').
 */
@Injectable()
export class FileManagerService {
  private readonly logger = new Logger(FileManagerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditEventService,
  ) {}

  /* ── Reads ──────────────────────────────────────────────────────── */

  /** List folders + files in the given folder (null = root). Returns
   *  the breadcrumb trail from root → requested folder as well so the
   *  FE can render navigation without a second round-trip. */
  async listFolder(folderId: string | null) {
    if (folderId) await this.ensureFolderExists(folderId);
    const [folders, files, breadcrumbs] = await Promise.all([
      this.prisma.fileManagerFolder.findMany({
        where: { parentId: folderId },
        orderBy: { name: 'asc' },
        include: {
          _count: { select: { children: true, files: true } },
        },
      }),
      this.prisma.fileManagerFile.findMany({
        where: { folderId },
        orderBy: { createdAt: 'desc' },
        include: {
          uploadedBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      }),
      this.buildBreadcrumbs(folderId),
    ]);
    return {
      folderId,
      breadcrumbs,
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        createdById: f.createdById,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        childFolderCount: f._count.children,
        fileCount: f._count.files,
      })),
      files: files.map((f) => this.mapFile(f)),
    };
  }

  /** Portal-user root view: a flat listing of the top-level resources
   *  the user has been shared, regardless of their actual position
   *  in the folder tree. Both direct-folder shares and direct-file
   *  shares surface here. */
  async listSharedTopLevel(
    sharedFolderIds: string[],
    sharedFileIds: string[],
  ) {
    const [folders, files] = await Promise.all([
      sharedFolderIds.length > 0
        ? this.prisma.fileManagerFolder.findMany({
            where: { id: { in: sharedFolderIds } },
            orderBy: { name: 'asc' },
            include: { _count: { select: { children: true, files: true } } },
          })
        : Promise.resolve([]),
      sharedFileIds.length > 0
        ? this.prisma.fileManagerFile.findMany({
            where: { id: { in: sharedFileIds } },
            orderBy: { createdAt: 'desc' },
            include: {
              uploadedBy: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
            },
          })
        : Promise.resolve([]),
    ]);
    return {
      folderId: null,
      breadcrumbs: [] as Array<{ id: string; name: string }>,
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        /* Hide real parentId from portal users — they only see this
         * folder as a top-level item. */
        parentId: null,
        createdById: f.createdById,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        childFolderCount: f._count.children,
        fileCount: f._count.files,
      })),
      files: files.map((f) => this.mapFile(f)),
    };
  }

  /** Portal-user folder view: like listFolder, but filters children
   *  by the user's open-folders scope (so non-shared sibling folders
   *  don't leak into the listing). Files inside the folder are all
   *  visible — the user already has access to the folder itself. */
  async listFolderFiltered(folderId: string, openFolderIds: Set<string>) {
    await this.ensureFolderExists(folderId);
    const [folders, files] = await Promise.all([
      this.prisma.fileManagerFolder.findMany({
        where: {
          parentId: folderId,
          id: { in: Array.from(openFolderIds) },
        },
        orderBy: { name: 'asc' },
        include: { _count: { select: { children: true, files: true } } },
      }),
      this.prisma.fileManagerFile.findMany({
        where: { folderId },
        orderBy: { createdAt: 'desc' },
        include: {
          uploadedBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      }),
    ]);
    return {
      folderId,
      /* Breadcrumbs show just the current folder — ancestors are
       * hidden since the portal user has no access to them. */
      breadcrumbs: await this.buildBreadcrumbsFiltered(folderId, openFolderIds),
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        createdById: f.createdById,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        childFolderCount: f._count.children,
        fileCount: f._count.files,
      })),
      files: files.map((f) => this.mapFile(f)),
    };
  }

  private async buildBreadcrumbsFiltered(
    folderId: string,
    openFolderIds: Set<string>,
  ) {
    const breadcrumbs: Array<{ id: string; name: string }> = [];
    let cursor: string | null = folderId;
    const seen = new Set<string>();
    while (cursor && openFolderIds.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const row = await this.prisma.fileManagerFolder.findUnique({
        where: { id: cursor },
        select: { id: true, name: true, parentId: true },
      });
      if (!row) break;
      breadcrumbs.unshift({ id: row.id, name: row.name });
      cursor = row.parentId;
    }
    return breadcrumbs;
  }

  /** Full folder tree, nested. Each node carries fileCount so the
   *  sidebar can render the little grey badge next to the name. */
  async listTree(): Promise<{ roots: FileManagerTreeNode[]; rootFileCount: number }> {
    const rows = await this.prisma.fileManagerFolder.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { files: true, children: true } } },
    });
    const map = new Map<string, FileManagerTreeNode>();
    const roots: FileManagerTreeNode[] = [];
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        name: r.name,
        parentId: r.parentId,
        fileCount: r._count.files,
        childFolderCount: r._count.children,
        children: [],
      });
    }
    for (const node of Array.from(map.values())) {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const rootFiles = await this.prisma.fileManagerFile.count({
      where: { folderId: null },
    });
    return { roots, rootFileCount: rootFiles };
  }

  /** Aggregate storage usage grouped by broad MIME category — drives
   *  the Storage card on the FileManager page. No quota; the card
   *  shows the distribution of what is actually in there. */
  async getStorageStats() {
    const files = await this.prisma.fileManagerFile.findMany({
      select: { mimeType: true, size: true },
    });
    const buckets = {
      images: 0,
      documents: 0,
      videos: 0,
      audio: 0,
      other: 0,
    };
    let total = 0;
    let count = 0;
    for (const f of files) {
      const bytes = f.size ?? 0;
      total += bytes;
      count += 1;
      const m = (f.mimeType ?? '').toLowerCase();
      if (m.startsWith('image/')) buckets.images += bytes;
      else if (m.startsWith('video/')) buckets.videos += bytes;
      else if (m.startsWith('audio/')) buckets.audio += bytes;
      else if (
        m.startsWith('text/') ||
        m === 'application/pdf' ||
        m.includes('word') ||
        m.includes('excel') ||
        m.includes('spreadsheet') ||
        m.includes('presentation') ||
        m.includes('powerpoint') ||
        m === 'application/rtf' ||
        m === 'application/json' ||
        m === 'application/xml'
      ) {
        buckets.documents += bytes;
      } else {
        buckets.other += bytes;
      }
    }
    return { total, count, buckets };
  }

  /* ── Folders ────────────────────────────────────────────────────── */

  async createFolder(
    name: string,
    parentId: string | undefined,
    actorUserId: string,
  ) {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('name is required');
    if (parentId) await this.ensureFolderExists(parentId);
    await this.assertNoFolderNameClash(parentId ?? null, trimmed);
    const row = await this.prisma.fileManagerFolder.create({
      data: { name: trimmed, parentId: parentId ?? null, createdById: actorUserId },
    });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.folder.create',
      targetType: 'FileManagerFolder',
      targetId: row.id,
      targetLabel: row.name,
      result: AuditResult.SUCCESS,
      metadata: { parentId: row.parentId },
    });
    return { id: row.id };
  }

  async renameFolder(id: string, name: string, actorUserId: string) {
    const row = await this.loadFolderOr404(id);
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('name is required');
    if (trimmed === row.name) return { id };
    await this.assertNoFolderNameClash(row.parentId, trimmed, id);
    await this.prisma.fileManagerFolder.update({
      where: { id },
      data: { name: trimmed },
    });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.folder.rename',
      targetType: 'FileManagerFolder',
      targetId: id,
      targetLabel: trimmed,
      result: AuditResult.SUCCESS,
      metadata: { previousName: row.name },
    });
    return { id };
  }

  async moveFolder(
    id: string,
    targetFolderId: string | null,
    actorUserId: string,
  ) {
    const row = await this.loadFolderOr404(id);
    if (targetFolderId === id) {
      throw new BadRequestException('A folder cannot be moved into itself.');
    }
    if (targetFolderId) {
      await this.ensureFolderExists(targetFolderId);
      await this.assertNotDescendantOf(targetFolderId, id);
    }
    await this.assertNoFolderNameClash(targetFolderId, row.name, id);
    await this.prisma.fileManagerFolder.update({
      where: { id },
      data: { parentId: targetFolderId },
    });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.folder.move',
      targetType: 'FileManagerFolder',
      targetId: id,
      targetLabel: row.name,
      result: AuditResult.SUCCESS,
      metadata: { from: row.parentId, to: targetFolderId },
    });
    return { id };
  }

  async deleteFolder(id: string, actorUserId: string) {
    const row = await this.loadFolderOr404(id);
    /* Recursively collect every file under this subtree so we can
     * best-effort drop their B2 objects. Postgres then cascades the
     * folder + file rows via FK ON DELETE CASCADE. */
    const files = await this.collectFilesUnder(id);
    for (const f of files) {
      try {
        await this.storage.deleteByName(StorageBucket.FILE_MANAGER, f.storageKey);
      } catch (err) {
        const msg = (err as Error).message || 'B2 delete failed';
        if (!/not found|404/i.test(msg)) {
          this.logger.warn(
            `[file-manager] B2 object stuck for ${f.storageKey}: ${msg}`,
          );
        }
      }
    }
    await this.prisma.fileManagerFolder.delete({ where: { id } });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.folder.delete',
      targetType: 'FileManagerFolder',
      targetId: id,
      targetLabel: row.name,
      result: AuditResult.SUCCESS,
      metadata: { descendantFileCount: files.length },
    });
    return { id };
  }

  /* ── Files ──────────────────────────────────────────────────────── */

  async uploadFile(input: UploadInput) {
    if (!input.file) throw new BadRequestException('file is required');
    if (input.file.size === 0) throw new BadRequestException('file is empty');
    if (input.file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `file exceeds the 100 MB limit (got ${input.file.size} bytes)`,
      );
    }
    if (input.folderId) await this.ensureFolderExists(input.folderId);
    const safeOriginal = this.sanitizeFileName(input.file.originalname);
    const storageKey = `file-manager/${input.folderId ?? 'root'}/${randomUUID()}-${safeOriginal}`;
    const uploaded = await this.storage.upload({
      bucket: StorageBucket.FILE_MANAGER,
      fileName: storageKey,
      buffer: input.file.buffer,
      mimeType: input.file.mimetype || 'application/octet-stream',
    });
    const row = await this.prisma.fileManagerFile.create({
      data: {
        folderId: input.folderId,
        originalName: input.file.originalname,
        storageKey: uploaded.key,
        mimeType: input.file.mimetype || 'application/octet-stream',
        size: input.file.size,
        uploadedById: input.actorUserId,
      },
      include: {
        uploadedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    await this.audit.record({
      actorUserId: input.actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.file.upload',
      targetType: 'FileManagerFile',
      targetId: row.id,
      targetLabel: input.file.originalname,
      result: AuditResult.SUCCESS,
      metadata: { folderId: input.folderId, size: input.file.size },
    });
    return this.mapFile(row);
  }

  async renameFile(id: string, name: string, actorUserId: string) {
    const row = await this.loadFileOr404(id);
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('name is required');
    if (trimmed === row.originalName) return { id };
    await this.prisma.fileManagerFile.update({
      where: { id },
      data: { originalName: trimmed },
    });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.file.rename',
      targetType: 'FileManagerFile',
      targetId: id,
      targetLabel: trimmed,
      result: AuditResult.SUCCESS,
      metadata: { previousName: row.originalName },
    });
    return { id };
  }

  async moveFile(id: string, targetFolderId: string | null, actorUserId: string) {
    const row = await this.loadFileOr404(id);
    if (targetFolderId) await this.ensureFolderExists(targetFolderId);
    await this.prisma.fileManagerFile.update({
      where: { id },
      data: { folderId: targetFolderId },
    });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.file.move',
      targetType: 'FileManagerFile',
      targetId: id,
      targetLabel: row.originalName,
      result: AuditResult.SUCCESS,
      metadata: { from: row.folderId, to: targetFolderId },
    });
    return { id };
  }

  async deleteFile(id: string, actorUserId: string) {
    const row = await this.loadFileOr404(id);
    try {
      await this.storage.deleteByName(StorageBucket.FILE_MANAGER, row.storageKey);
    } catch (err) {
      const msg = (err as Error).message || 'B2 delete failed';
      if (!/not found|404/i.test(msg)) {
        this.logger.warn(
          `[file-manager] B2 object stuck for ${row.storageKey}: ${msg}`,
        );
      }
    }
    await this.prisma.fileManagerFile.delete({ where: { id } });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.file.delete',
      targetType: 'FileManagerFile',
      targetId: id,
      targetLabel: row.originalName,
      result: AuditResult.SUCCESS,
      metadata: { folderId: row.folderId },
    });
    return { id };
  }

  /* ── Bulk ops ──────────────────────────────────────────────── */

  async bulkDelete(
    folderIds: string[],
    fileIds: string[],
    actorUserId: string,
  ): Promise<{
    deletedFolders: number;
    deletedFiles: number;
    failed: { id: string; kind: 'folder' | 'file'; reason: string }[];
  }> {
    const failed: { id: string; kind: 'folder' | 'file'; reason: string }[] = [];
    let deletedFiles = 0;
    let deletedFolders = 0;
    /* Files first — folder-cascade would also delete them, but doing
     * them independently gives a per-file success/fail report. */
    for (const id of fileIds) {
      try {
        await this.deleteFile(id, actorUserId);
        deletedFiles++;
      } catch (err) {
        failed.push({
          id,
          kind: 'file',
          reason: (err as Error).message || 'delete failed',
        });
      }
    }
    for (const id of folderIds) {
      try {
        await this.deleteFolder(id, actorUserId);
        deletedFolders++;
      } catch (err) {
        failed.push({
          id,
          kind: 'folder',
          reason: (err as Error).message || 'delete failed',
        });
      }
    }
    return { deletedFolders, deletedFiles, failed };
  }

  async bulkMove(
    folderIds: string[],
    fileIds: string[],
    destinationFolderId: string | null,
    actorUserId: string,
  ): Promise<{
    movedFolders: number;
    movedFiles: number;
    failed: { id: string; kind: 'folder' | 'file'; reason: string }[];
  }> {
    /* Cycle check: destination must not be the same as, or a
     * descendant of, any folder being moved. Walk destination's
     * ancestor chain via the parent pointer and bail if we meet one
     * of the sources. */
    if (destinationFolderId && folderIds.length > 0) {
      const sources = new Set(folderIds);
      let cursor: string | null = destinationFolderId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        if (sources.has(cursor)) {
          throw new BadRequestException(
            'Cannot move a folder into itself or its own subtree',
          );
        }
        const row = await this.prisma.fileManagerFolder.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
        cursor = row?.parentId ?? null;
      }
    }

    const failed: { id: string; kind: 'folder' | 'file'; reason: string }[] = [];
    let movedFolders = 0;
    let movedFiles = 0;
    for (const id of folderIds) {
      try {
        await this.moveFolder(id, destinationFolderId, actorUserId);
        movedFolders++;
      } catch (err) {
        failed.push({
          id,
          kind: 'folder',
          reason: (err as Error).message || 'move failed',
        });
      }
    }
    for (const id of fileIds) {
      try {
        await this.moveFile(id, destinationFolderId, actorUserId);
        movedFiles++;
      } catch (err) {
        failed.push({
          id,
          kind: 'file',
          reason: (err as Error).message || 'move failed',
        });
      }
    }
    return { movedFolders, movedFiles, failed };
  }

  async getDownloadUrl(id: string, actorUserId: string) {
    const row = await this.loadFileOr404(id);
    const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(row.originalName)}`;
    const url = await this.storage.getDownloadUrl(
      StorageBucket.FILE_MANAGER,
      row.storageKey,
      undefined,
      disposition,
    );
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.file.download_url',
      targetType: 'FileManagerFile',
      targetId: row.id,
      targetLabel: row.originalName,
      result: AuditResult.SUCCESS,
      metadata: { folderId: row.folderId },
    });
    return { url, fileName: row.originalName };
  }

  async getInlineUrl(id: string, actorUserId: string) {
    const row = await this.loadFileOr404(id);
    const url = await this.storage.getDownloadUrl(
      StorageBucket.FILE_MANAGER,
      row.storageKey,
    );
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.file.inline_url',
      targetType: 'FileManagerFile',
      targetId: row.id,
      targetLabel: row.originalName,
      result: AuditResult.SUCCESS,
      metadata: { folderId: row.folderId },
    });
    return { url, mimeType: row.mimeType };
  }

  /* ── Helpers ────────────────────────────────────────────────────── */

  private async buildBreadcrumbs(folderId: string | null) {
    if (!folderId) return [];
    const chain: Array<{ id: string; name: string }> = [];
    let current: string | null = folderId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const row = await this.prisma.fileManagerFolder.findUnique({
        where: { id: current },
        select: { id: true, name: true, parentId: true },
      });
      if (!row) break;
      chain.unshift({ id: row.id, name: row.name });
      current = row.parentId;
    }
    return chain;
  }

  private async ensureFolderExists(id: string): Promise<void> {
    const row = await this.prisma.fileManagerFolder.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Folder not found');
  }

  private async loadFolderOr404(id: string) {
    const row = await this.prisma.fileManagerFolder.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Folder not found');
    return row;
  }

  private async loadFileOr404(id: string) {
    const row = await this.prisma.fileManagerFile.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('File not found');
    return row;
  }

  private async assertNoFolderNameClash(
    parentId: string | null,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const clash = await this.prisma.fileManagerFolder.findFirst({
      where: {
        parentId,
        name,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(
        `A folder named "${name}" already exists in this location.`,
      );
    }
  }

  /* Walks the subtree downward and refuses `target` that would create
   * a cycle (e.g. moving a parent into one of its own descendants). */
  private async assertNotDescendantOf(
    candidateChildId: string,
    ancestorId: string,
  ): Promise<void> {
    let current: string | null = candidateChildId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === ancestorId) {
        throw new BadRequestException(
          'Cannot move a folder into one of its own descendants.',
        );
      }
      seen.add(current);
      const row: { parentId: string | null } | null =
        await this.prisma.fileManagerFolder.findUnique({
          where: { id: current },
          select: { parentId: true },
        });
      current = row?.parentId ?? null;
    }
  }

  private async collectFilesUnder(folderId: string) {
    const files: Array<{ id: string; storageKey: string }> = [];
    const stack = [folderId];
    const seen = new Set<string>();
    while (stack.length) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const [childFolders, childFiles] = await Promise.all([
        this.prisma.fileManagerFolder.findMany({
          where: { parentId: current },
          select: { id: true },
        }),
        this.prisma.fileManagerFile.findMany({
          where: { folderId: current },
          select: { id: true, storageKey: true },
        }),
      ]);
      for (const f of childFiles) files.push(f);
      for (const f of childFolders) stack.push(f.id);
    }
    return files;
  }

  private sanitizeFileName(name: string): string {
    return name
      .replace(/[^\w.\-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 160);
  }

  private mapFile(row: {
    id: string;
    folderId: string | null;
    originalName: string;
    mimeType: string;
    size: number;
    createdAt: Date;
    updatedAt: Date;
    uploadedBy?: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    } | null;
  }) {
    return {
      id: row.id,
      folderId: row.folderId,
      originalName: row.originalName,
      mimeType: row.mimeType,
      size: row.size,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      uploadedBy: row.uploadedBy
        ? {
            id: row.uploadedBy.id,
            name: `${row.uploadedBy.firstName} ${row.uploadedBy.lastName}`.trim(),
            email: row.uploadedBy.email,
          }
        : null,
    };
  }
}
