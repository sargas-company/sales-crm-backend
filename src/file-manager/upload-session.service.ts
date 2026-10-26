import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import {
  AuditResult,
  FileManagerUploadSession,
  FileManagerUploadStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { StorageBucket } from '../storage/storage.types';
import { AuditEventService } from '../audit-event/audit-event.service';

import { InitUploadDto } from './dto/init-upload.dto';

/* Resumable upload sessions — one row per in-flight upload. Backs
 * the chunked / resumable path with B2's large-file multipart API.
 *
 * Owner-approved parameters (session 2026-10-25):
 *   CHUNK_SIZE = 8 MiB
 *   TTL        = 48 hours
 *   MAX_SIZE   = 1 GiB
 *
 * B2 requires minimum part size of 5 MiB (except the final part).
 * 8 MiB satisfies that with headroom. */

const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MiB — halves chunk count vs 8 MiB
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB — covers 4 GiB target with headroom
const B2_MIN_PART_BYTES = 5 * 1024 * 1024;

@Injectable()
export class UploadSessionService {
  private readonly logger = new Logger(UploadSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditEventService,
  ) {}

  /* ── Init ─────────────────────────────────────────────────────── */

  async init(dto: InitUploadDto, actorUserId: string) {
    if (dto.size <= 0) throw new BadRequestException('size must be > 0');
    if (dto.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `file exceeds the ${MAX_UPLOAD_BYTES} byte limit (got ${dto.size})`,
      );
    }

    if (dto.folderId) {
      const folder = await this.prisma.fileManagerFolder.findUnique({
        where: { id: dto.folderId },
        select: { id: true },
      });
      if (!folder) throw new NotFoundException('folder not found');
    }

    const safeOriginal = this.sanitize(dto.fileName);
    const storageKey = `file-manager/${dto.folderId ?? 'root'}/${randomUUID()}-${safeOriginal}`;

    const totalParts = Math.max(1, Math.ceil(dto.size / CHUNK_SIZE));

    /* B2 refuses `finishLargeFile` on multipart with only 1 part
     * ("large files must have at least 2 parts"). Small files that
     * fit in a single chunk go through the single-shot upload path
     * instead — we mark the session with an empty b2FileId and
     * handle part/finalize paths differently below. */
    let fileId = '';
    if (totalParts > 1) {
      const res = await this.storage.startLarge(
        StorageBucket.FILE_MANAGER,
        storageKey,
        dto.mimeType,
      );
      fileId = res.fileId;
    }
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const session = await this.prisma.fileManagerUploadSession.create({
      data: {
        userId: actorUserId,
        folderId: dto.folderId ?? null,
        fileName: dto.fileName,
        mimeType: dto.mimeType || 'application/octet-stream',
        size: dto.size,
        sha1: dto.sha1,
        chunkSize: CHUNK_SIZE,
        totalParts,
        storageKey,
        b2FileId: fileId,
        expiresAt,
      },
    });

    return this.toPublic(session);
  }

  /* ── Part upload ──────────────────────────────────────────────── */

  async uploadPart(
    sessionId: string,
    partIndex: number,
    buffer: Buffer,
    actorUserId: string,
  ) {
    const session = await this.loadOwned(sessionId, actorUserId);
    this.ensureOpen(session);

    if (!Number.isInteger(partIndex) || partIndex < 1 || partIndex > session.totalParts) {
      throw new BadRequestException(
        `partIndex must be 1..${session.totalParts}`,
      );
    }

    const isLast = partIndex === session.totalParts;
    if (!isLast && buffer.length !== session.chunkSize) {
      throw new BadRequestException(
        `part ${partIndex} must be exactly ${session.chunkSize} bytes (got ${buffer.length})`,
      );
    }
    if (isLast) {
      const expected = session.size - session.chunkSize * (session.totalParts - 1);
      if (buffer.length !== expected) {
        throw new BadRequestException(
          `last part ${partIndex} must be ${expected} bytes (got ${buffer.length})`,
        );
      }
    }
    /* B2 rejects parts smaller than 5 MiB except the final one — our
     * chunk size (8 MiB) is above the floor, so this only matters if
     * the whole file fits in one chunk (totalParts === 1). */
    if (!isLast && buffer.length < B2_MIN_PART_BYTES) {
      throw new BadRequestException(
        `non-final part must be at least ${B2_MIN_PART_BYTES} bytes`,
      );
    }

    const sha1 = createHash('sha1').update(buffer).digest('hex');
    /* Single-shot path (session.b2FileId === '') — upload the whole
     * buffer via the regular put-file endpoint. finishLarge is never
     * called; finalize just creates the DB row. */
    if (session.b2FileId === '') {
      await this.storage.upload({
        bucket: StorageBucket.FILE_MANAGER,
        fileName: session.storageKey,
        buffer,
        mimeType: session.mimeType,
      });
    } else {
      await this.storage.uploadLargePart(session.b2FileId, partIndex, buffer, sha1);
    }

    /* Record this part in the session. Use a tx to keep partsReceived
     * and partSha1s aligned. Idempotent: re-uploading the same part
     * replaces its sha1 but doesn't duplicate the index. */
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.fileManagerUploadSession.findUnique({
        where: { id: sessionId },
      });
      if (!current) throw new NotFoundException('session gone');
      const existingAt = current.partsReceived.indexOf(partIndex);
      let partsReceived: number[];
      let partSha1s: string[];
      if (existingAt >= 0) {
        partsReceived = current.partsReceived;
        partSha1s = [...current.partSha1s];
        partSha1s[existingAt] = sha1;
      } else {
        partsReceived = [...current.partsReceived, partIndex];
        partSha1s = [...current.partSha1s, sha1];
      }
      return tx.fileManagerUploadSession.update({
        where: { id: sessionId },
        data: {
          partsReceived,
          partSha1s,
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        },
      });
    });

    return {
      received: updated.partsReceived.length,
      total: updated.totalParts,
    };
  }

  /* ── Finalize ─────────────────────────────────────────────────── */

  async finalize(sessionId: string, actorUserId: string) {
    const session = await this.loadOwned(sessionId, actorUserId);
    this.ensureOpen(session);

    const expectedParts = Array.from(
      { length: session.totalParts },
      (_, i) => i + 1,
    );
    const got = new Set(session.partsReceived);
    const missing = expectedParts.filter((n) => !got.has(n));
    if (missing.length) {
      throw new BadRequestException(
        `cannot finalize: missing parts ${missing.slice(0, 5).join(', ')}${
          missing.length > 5 ? ` (+${missing.length - 5} more)` : ''
        }`,
      );
    }

    /* Single-shot path (empty b2FileId) uploaded the whole file in
     * one request to B2's regular put-file endpoint — nothing to
     * finalise on B2's side, straight to DB. */
    if (session.b2FileId !== '') {
      /* B2 wants partSha1Array ordered by partNumber ascending. Our
       * partSha1s is in insertion order (which may be out of order),
       * so re-sort by partsReceived. */
      const paired = session.partsReceived.map((n, i) => ({
        n,
        sha1: session.partSha1s[i],
      }));
      paired.sort((a, b) => a.n - b.n);
      const partSha1Array = paired.map((p) => p.sha1);
      await this.storage.finishLarge(session.b2FileId, partSha1Array);
    }

    const file = await this.prisma.$transaction(async (tx) => {
      const row = await tx.fileManagerFile.create({
        data: {
          folderId: session.folderId,
          originalName: session.fileName,
          storageKey: session.storageKey,
          mimeType: session.mimeType,
          size: session.size,
          uploadedById: actorUserId,
        },
        include: {
          uploadedBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      });
      await tx.fileManagerUploadSession.update({
        where: { id: sessionId },
        data: { status: FileManagerUploadStatus.FINALIZED },
      });
      return row;
    });

    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.file.upload',
      targetType: 'FileManagerFile',
      targetId: file.id,
      targetLabel: session.fileName,
      result: AuditResult.SUCCESS,
      metadata: {
        folderId: session.folderId,
        size: session.size,
        resumable: true,
        sessionId,
      },
    });

    return {
      id: file.id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      folderId: file.folderId,
      createdAt: file.createdAt,
      uploadedBy: file.uploadedBy,
    };
  }

  /* ── Cancel ───────────────────────────────────────────────────── */

  async cancel(sessionId: string, actorUserId: string) {
    const session = await this.loadOwned(sessionId, actorUserId);
    if (session.status !== FileManagerUploadStatus.OPEN) {
      return { id: sessionId, status: session.status };
    }
    if (session.b2FileId !== '') {
      await this.storage.cancelLarge(session.b2FileId);
    }
    const updated = await this.prisma.fileManagerUploadSession.update({
      where: { id: sessionId },
      data: { status: FileManagerUploadStatus.ABORTED },
    });
    return { id: updated.id, status: updated.status };
  }

  /* ── Reads ────────────────────────────────────────────────────── */

  async get(sessionId: string, actorUserId: string) {
    const session = await this.loadOwned(sessionId, actorUserId);
    return this.toPublic(session);
  }

  /** Returns open sessions for the given user — powers the frontend
   *  reload-restore flow. Only sessions still in the TTL window. */
  async listMine(actorUserId: string) {
    const rows = await this.prisma.fileManagerUploadSession.findMany({
      where: {
        userId: actorUserId,
        status: FileManagerUploadStatus.OPEN,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.toPublic(r));
  }

  /* ── Cron: cleanup expired sessions ───────────────────────────── */

  async sweepExpired(): Promise<{ cancelled: number; errors: number }> {
    const expired = await this.prisma.fileManagerUploadSession.findMany({
      where: {
        status: FileManagerUploadStatus.OPEN,
        expiresAt: { lt: new Date() },
      },
      take: 100,
    });
    let cancelled = 0;
    let errors = 0;
    for (const s of expired) {
      try {
        if (s.b2FileId !== '') {
          await this.storage.cancelLarge(s.b2FileId);
        }
        await this.prisma.fileManagerUploadSession.update({
          where: { id: s.id },
          data: { status: FileManagerUploadStatus.ABORTED },
        });
        cancelled++;
      } catch (err: unknown) {
        errors++;
        this.logger.warn(
          `sweepExpired: session ${s.id} failed: ${(err as { message?: string })?.message}`,
        );
      }
    }
    if (cancelled || errors) {
      this.logger.log(`sweepExpired: cancelled=${cancelled} errors=${errors}`);
    }
    return { cancelled, errors };
  }

  /* ── Helpers ──────────────────────────────────────────────────── */

  private async loadOwned(sessionId: string, actorUserId: string) {
    const row = await this.prisma.fileManagerUploadSession.findUnique({
      where: { id: sessionId },
    });
    if (!row) throw new NotFoundException('upload session not found');
    if (row.userId !== actorUserId) {
      throw new ForbiddenException('upload session belongs to another user');
    }
    return row;
  }

  private ensureOpen(session: FileManagerUploadSession) {
    if (session.status !== FileManagerUploadStatus.OPEN) {
      throw new BadRequestException(
        `session is ${session.status.toLowerCase()}, no further parts accepted`,
      );
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('session has expired');
    }
  }

  private sanitize(name: string): string {
    return name
      .normalize('NFKD')
      .replace(/[^\w.\-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 150);
  }

  private toPublic(s: FileManagerUploadSession) {
    return {
      id: s.id,
      folderId: s.folderId,
      fileName: s.fileName,
      mimeType: s.mimeType,
      size: s.size,
      sha1: s.sha1,
      chunkSize: s.chunkSize,
      totalParts: s.totalParts,
      partsReceived: s.partsReceived.slice().sort((a, b) => a - b),
      status: s.status,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
    } satisfies Prisma.JsonObject | object;
  }
}
