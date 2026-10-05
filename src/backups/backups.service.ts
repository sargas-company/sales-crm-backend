import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BackupStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Read-only Backups service.
 *
 * Backup creation lives entirely in `scripts/backup.ts` + the shared
 * `backup-runner`. The HTTP backend never spawns `pg_dump`, never
 * touches B2 for backups, and never holds the backup credentials.
 * This service only serves list / details / summary rows out of the
 * `BackupRun` table so the admin UI can show history and status.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(page = 1, limit = 25) {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.backupRun.findMany({
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.backupRun.count(),
    ]);
    return {
      data: data.map((r) => this.serialize(r)),
      total,
      page,
      limit,
    };
  }

  async summary() {
    const [last, lastVerified, lastFailed, total] = await Promise.all([
      this.prisma.backupRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      this.prisma.backupRun.findFirst({
        where: { status: BackupStatus.VERIFIED },
        orderBy: { lastVerifiedAt: 'desc' },
      }),
      this.prisma.backupRun.findFirst({
        where: { status: BackupStatus.FAILED },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.backupRun.count(),
    ]);
    return {
      last: last ? this.serialize(last) : null,
      lastVerified: lastVerified ? this.serialize(lastVerified) : null,
      lastFailed: lastFailed ? this.serialize(lastFailed) : null,
      total,
    };
  }

  async get(id: string) {
    const run = await this.prisma.backupRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('BackupRun not found');
    return this.serialize(run);
  }

  private serialize<T extends { size?: unknown }>(r: T) {
    // `size` is BigInt in Prisma — convert for JSON.
    const row = r as Record<string, unknown>;
    return {
      ...row,
      size:
        row.size !== null && row.size !== undefined
          ? String(row.size as bigint)
          : null,
    };
  }
}
