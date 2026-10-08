import * as path from 'path';
import { randomUUID } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';

import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { IncomingFileData, StorageBucket, StorageService, StoredFileMetadata } from '../storage';
import { CreateClientRequestDto } from './dto/create-client-request.dto';
import {
  ClientRequestSortBy,
  ClientRequestSortDirection,
  ListClientRequestsDto,
} from './dto/list-client-requests.dto';
import { UpdateClientRequestDto } from './dto/update-client-request.dto';

@Injectable()
export class ClientRequestsService {
  private readonly logger = new Logger(ClientRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly storage: StorageService,
  ) {}

  async findAll(dto: ListClientRequestsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? ClientRequestSortDirection.desc;

    const where: Prisma.ClientRequestWhereInput = dto.search
      ? { name: { contains: dto.search, mode: 'insensitive' } }
      : {};

    const orderBy = this.buildOrderBy(dto.sortBy, dir);

    const [data, total] = await Promise.all([
      this.prisma.clientRequest.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
      }),
      this.prisma.clientRequest.count({ where }),
    ]);

    return { data, total };
  }

  private buildOrderBy(
    sortBy: ClientRequestSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.ClientRequestOrderByWithRelationInput {
    switch (sortBy) {
      case ClientRequestSortBy.name:
        return { name: dir };
      case ClientRequestSortBy.email:
        return { email: dir };
      case ClientRequestSortBy.phoneCountry:
        return { phoneCountry: { sort: dir, nulls: 'last' } };
      case ClientRequestSortBy.status:
        return { status: dir };
      case ClientRequestSortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  async findOne(id: string) {
    const request = await this.prisma.clientRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Client request not found');
    return request;
  }

  async update(id: string, dto: UpdateClientRequestDto) {
    const request = await this.prisma.clientRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Client request not found');

    return this.prisma.clientRequest.update({
      where: { id },
      data: {
        name: dto.name,
        company: dto.company,
        email: dto.email,
        phone: dto.phone,
        phoneCountry: dto.phoneCountry,
        message: dto.message,
        services: dto.services,
        status: dto.status,
      },
    });
  }

  async remove(id: string) {
    const request = await this.findOne(id);
    const storedFiles = (request.files as unknown) as StoredFileMetadata[];
    const folderPrefix = storedFiles.length > 0
      ? storedFiles[0].fileName.split('/')[0] + '/'
      : `${id}/`;
    await this.storage.deleteFolder(StorageBucket.CLIENT_REQUESTS, folderPrefix);
    await this.prisma.clientRequest.delete({ where: { id } });
  }

  /**
   * Bulk delete under the same permission as single-remove. B2 folder
   * cleanup runs per-row with best-effort — a failed storage delete
   * does NOT block the DB cleanup (storage leak is strictly better
   * than orphaned rows). Cascade on `ClientCall → ClientRequest`
   * removes dependent calls automatically. Stale ids silently drop.
   */
  async bulkRemove(ids: string[]): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const rows = await this.prisma.clientRequest.findMany({
      where: { id: { in: ids } },
      select: { id: true, files: true },
    });
    await Promise.all(
      rows.map(async (row) => {
        const storedFiles = (row.files as unknown) as StoredFileMetadata[];
        const folderPrefix =
          storedFiles.length > 0
            ? storedFiles[0].fileName.split('/')[0] + '/'
            : `${row.id}/`;
        try {
          await this.storage.deleteFolder(
            StorageBucket.CLIENT_REQUESTS,
            folderPrefix,
          );
        } catch {
          /* swallow — storage leak is acceptable; DB row removal is
             the primary guarantee. */
        }
      }),
    );
    const result = await this.prisma.clientRequest.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    return { deleted: result.count };
  }

  async getFilesDownloadUrls(id: string): Promise<{ originalName: string; url: string; mimetype: string; size: number }[]> {
    const request = await this.findOne(id);
    const storedFiles = (request.files as unknown) as StoredFileMetadata[];

    return Promise.all(
      storedFiles.map(async (f) => {
        // Resolve the object key. New rows store it directly in
        // `fileName`; very old rows may have a permanent B2 URL in
        // `url` with no key alongside — fall back to extracting it.
        const key =
          f.fileName ||
          (f.url ? this.storage.extractKeyFromLegacyUrl(f.url) : null);
        if (!key) {
          throw new NotFoundException(
            `Client request file "${f.originalName}" has no resolvable key`,
          );
        }
        return {
          originalName: f.originalName,
          mimetype: f.mimetype,
          size: f.size,
          url: await this.storage.getDownloadUrl(
            StorageBucket.CLIENT_REQUESTS,
            key,
          ),
        };
      }),
    );
  }

  async create(dto: CreateClientRequestDto, files: IncomingFileData[]) {
    const request = await this.prisma.clientRequest.create({
      data: {
        name: dto.name,
        company: dto.company,
        email: dto.email,
        phone: dto.phone,
        phoneCountry: dto.phoneCountry,
        message: dto.message,
        services: dto.services ?? [],
        files: [],
      },
    });

    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const d = request.createdAt;
    const shortId = request.id.slice(0, 8);
    const folderName = `${request.name} - ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} (${shortId})`
      .replace(/[^\p{L}\p{N} \-_.,()]/gu, '')
      .trim();

    // Compensating cleanup: if any part of the write path fails after
    // some files have reached B2, remove the uploaded objects + the
    // half-populated request row so we never leave B2 orphans.
    const uploadedKeys: string[] = [];
    let storedFiles: StoredFileMetadata[] = [];
    try {
      storedFiles = await Promise.all(
        files.map(async (file) => {
          const ext = path.extname(file.originalName);
          const baseName = path
            .basename(file.originalName, ext)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60);
          // Collision-proof suffix — Date.now() alone collided across
          // concurrent uploads inside the same request.
          const uniq = randomUUID().slice(0, 8);
          const fileName = `${folderName}/${new Date()
            .toISOString()
            .slice(0, 10)}-${baseName}-${uniq}${ext}`;

          const { fileId, key } = await this.storage.upload({
            bucket: StorageBucket.CLIENT_REQUESTS,
            fileName,
            buffer: file.buffer,
            mimeType: file.mimetype,
          });
          uploadedKeys.push(key);

          // Key is the source of truth. `url` is intentionally NOT
          // persisted for new rows — buckets are private, so a long-
          // lived URL would be useless and risky.
          return {
            originalName: file.originalName,
            fileName: key,
            fileId,
            mimetype: file.mimetype,
            size: file.size,
          };
        }),
      );

      if (storedFiles.length > 0) {
        await this.prisma.clientRequest.update({
          where: { id: request.id },
          data: { files: storedFiles as object[] },
        });
      }
    } catch (err) {
      await this.cleanupOrphans(request.id, uploadedKeys);
      throw err;
    }

    try {
      await this.notificationService.createEvent(NotificationType.CLIENT_REQUEST, {
        clientRequestId: request.id,
        name: request.name,
        email: request.email,
        company: request.company ?? null,
        phone: request.phone ?? null,
        phoneCountry: request.phoneCountry ?? null,
        services: request.services,
        message: request.message ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Failed to create NotificationEvent for clientRequest ${request.id}: ${(err as Error).message}`,
      );
    }

    return request;
  }

  /**
   * Best-effort cleanup when the create-flow fails after some uploads
   * have already landed in B2. We delete the uploaded objects and the
   * half-populated request row so a retried submission starts clean.
   */
  private async cleanupOrphans(requestId: string, keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.deleteByName(StorageBucket.CLIENT_REQUESTS, key);
      } catch (err) {
        this.logger.warn(
          `Orphan cleanup: could not delete ${key}: ${(err as Error).message}`,
        );
      }
    }
    try {
      await this.prisma.clientRequest.delete({ where: { id: requestId } });
    } catch (err) {
      this.logger.warn(
        `Orphan cleanup: could not delete request ${requestId}: ${
          (err as Error).message
        }`,
      );
    }
  }
}