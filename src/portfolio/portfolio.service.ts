import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditResult,
  AuditSeverity,
  PortfolioAssetKind,
  PortfolioStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { safeDiff } from '../audit-event/audit-sanitizer';
import { StorageBucket, StorageService } from '../storage';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';

/** Convert "Hello World!" → "hello-world". Stable. */
function toSlug(input: string): string {
  const base = (input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, 80) || 'item';
}

function normalizeTag(raw: string): { normalized: string; displayName: string } {
  const displayName = raw.trim();
  return { normalized: displayName.toLowerCase(), displayName };
}

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Build the storage key for an upload honoring the folder policy.
   * The key includes a short UUID suffix so simultaneous uploads of
   * the same filename never collide (`Date.now()` alone did).
   */
  private async buildStorageKey(
    itemId: string,
    kind: PortfolioAssetKind,
    fileName: string,
  ): Promise<string> {
    const separate = await this.settings.getBooleanForKey(
      SK.PORTFOLIO_SEPARATE_FOLDERS,
      true,
    );
    const sub =
      kind === PortfolioAssetKind.COVER
        ? 'covers'
        : kind === PortfolioAssetKind.IMAGE
          ? 'images'
          : 'files';
    const base = separate
      ? `portfolio/${itemId}/${sub}`
      : `portfolio/${itemId}`;
    const uniq = randomUUID().slice(0, 8);
    return `${base}/${Date.now()}_${uniq}_${fileName}`;
  }

  /** Enforce per-kind and per-item size/count limits before accepting an
   *  upload. Throws BadRequest when a limit would be exceeded. */
  private async assertUploadWithinLimits(
    itemId: string,
    kind: PortfolioAssetKind,
    size: number,
  ): Promise<void> {
    const [
      maxCoverMb,
      maxGalleryCount,
      maxGalleryMb,
      maxFiles,
      maxFileMb,
      maxFilesTotalMb,
    ] = await Promise.all([
      this.settings.getNumberForKey(SK.PORTFOLIO_MAX_COVER_MB, 5),
      this.settings.getNumberForKey(SK.PORTFOLIO_MAX_GALLERY_ITEMS, 10),
      this.settings.getNumberForKey(SK.PORTFOLIO_MAX_GALLERY_MB, 8),
      this.settings.getNumberForKey(SK.PORTFOLIO_MAX_FILES, 10),
      this.settings.getNumberForKey(SK.PORTFOLIO_MAX_FILE_MB, 25),
      this.settings.getNumberForKey(SK.PORTFOLIO_MAX_FILES_TOTAL_MB, 50),
    ]);
    const sizeMb = size / (1024 * 1024);

    if (kind === PortfolioAssetKind.COVER) {
      if (sizeMb > maxCoverMb)
        throw new BadRequestException(
          `Cover exceeds the ${maxCoverMb} MB limit.`,
        );
      return;
    }
    if (kind === PortfolioAssetKind.IMAGE) {
      if (sizeMb > maxGalleryMb)
        throw new BadRequestException(
          `Gallery image exceeds the ${maxGalleryMb} MB limit.`,
        );
      const current = await this.prisma.portfolioAsset.count({
        where: { itemId, kind: PortfolioAssetKind.IMAGE },
      });
      if (current + 1 > maxGalleryCount)
        throw new BadRequestException(
          `Gallery already has ${maxGalleryCount} images.`,
        );
      return;
    }
    // FILE
    if (sizeMb > maxFileMb)
      throw new BadRequestException(
        `Attachment exceeds the ${maxFileMb} MB limit.`,
      );
    const [count, agg] = await Promise.all([
      this.prisma.portfolioAsset.count({
        where: { itemId, kind: PortfolioAssetKind.FILE },
      }),
      this.prisma.portfolioAsset.aggregate({
        where: { itemId, kind: PortfolioAssetKind.FILE },
        _sum: { size: true },
      }),
    ]);
    if (count + 1 > maxFiles)
      throw new BadRequestException(
        `Attachments already at the ${maxFiles} limit.`,
      );
    const usedBytes = agg._sum.size ?? 0;
    const totalMb = (usedBytes + size) / (1024 * 1024);
    if (totalMb > maxFilesTotalMb)
      throw new BadRequestException(
        `Combined attachments would exceed the ${maxFilesTotalMb} MB budget.`,
      );
  }

  // ─── Items ─────────────────────────────────────────────────────

  async list(query: {
    q?: string;
    status?: PortfolioStatus;
    isNda?: boolean;
    tag?: string;
    page?: number;
    limit?: number;
    sort?: 'updatedAt' | 'createdAt' | 'title' | 'status';
    direction?: 'asc' | 'desc';
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.PortfolioItemWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.isNda !== undefined ? { isNda: query.isNda } : {}),
      ...(query.tag
        ? {
            tags: {
              some: { tag: { normalized: query.tag.toLowerCase() } },
            },
          }
        : {}),
      ...(query.q
        ? { title: { contains: query.q, mode: 'insensitive' } }
        : {}),
    };
    const dir: Prisma.SortOrder = query.direction ?? 'desc';
    const orderBy: Prisma.PortfolioItemOrderByWithRelationInput =
      query.sort === 'title'
        ? { title: dir }
        : query.sort === 'status'
          ? { status: dir }
          : query.sort === 'createdAt'
            ? { createdAt: dir }
            : { updatedAt: dir };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.portfolioItem.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: this.listInclude(),
      }),
      this.prisma.portfolioItem.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async get(idOrSlug: string) {
    const item = await this.prisma.portfolioItem.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        tags: { include: { tag: true } },
        coverAsset: true,
        assets: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!item) throw new NotFoundException('Portfolio item not found');
    return item;
  }

  async create(
    dto: {
      title: string;
      slug?: string;
      shortSummary?: string;
      status?: PortfolioStatus;
      isNda?: boolean;
      contentMarkdown?: string;
      tags?: string[];
    },
    actorId: string,
  ) {
    const title = (dto.title ?? '').trim();
    if (!title) throw new BadRequestException('title required');
    /* Admin can choose whether the slug may be derived automatically.
     * When auto-slug is off, the user must supply it explicitly. */
    const autoSlug = await this.settings.getBooleanForKey(
      SK.PORTFOLIO_AUTO_SLUG,
      true,
    );
    let candidate = dto.slug;
    if (!candidate) {
      if (!autoSlug)
        throw new BadRequestException('slug required (auto-slug is off)');
      candidate = toSlug(title);
    }
    const slug = await this.resolveUniqueSlug(candidate);
    const defaultStatusRaw = await this.settings.getStringForKey(
      SK.PORTFOLIO_DEFAULT_STATUS,
      'DRAFT',
    );
    const defaultStatus: PortfolioStatus =
      defaultStatusRaw === 'READY'
        ? PortfolioStatus.READY
        : PortfolioStatus.DRAFT;
    const tagRecords = await this.ensureTags(dto.tags ?? []);
    const created = await this.prisma.portfolioItem.create({
      data: {
        title,
        slug,
        shortSummary: dto.shortSummary ?? null,
        status: dto.status ?? defaultStatus,
        isNda: dto.isNda ?? false,
        contentMarkdown: dto.contentMarkdown ?? '',
        createdById: actorId,
        updatedById: actorId,
        tags: {
          create: tagRecords.map((t) => ({ tagId: t.id })),
        },
      },
      include: this.fullInclude(),
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'CRM',
      action: 'portfolio.create',
      targetType: 'PortfolioItem',
      targetId: created.id,
      targetLabel: created.title,
      targetHref: `/portfolio/${created.slug}`,
      result: AuditResult.SUCCESS,
      metadata: {
        status: created.status,
        isNda: created.isNda,
        tagCount: tagRecords.length,
      },
    });
    return created;
  }

  async update(
    id: string,
    dto: {
      title?: string;
      slug?: string;
      shortSummary?: string | null;
      status?: PortfolioStatus;
      isNda?: boolean;
      contentMarkdown?: string;
      tags?: string[];
    },
    actorId: string,
  ) {
    const existing = await this.prisma.portfolioItem.findUnique({
      where: { id },
      include: { tags: { include: { tag: true } } },
    });
    if (!existing) throw new NotFoundException('Portfolio item not found');

    const newSlug =
      dto.slug !== undefined && dto.slug !== existing.slug
        ? await this.resolveUniqueSlug(dto.slug, id)
        : undefined;

    const markdownChanged =
      dto.contentMarkdown !== undefined &&
      dto.contentMarkdown !== existing.contentMarkdown;

    const previousTagKeys = existing.tags
      .map((t) => t.tag.normalized)
      .sort();

    let newTagRecords: { id: string; normalized: string }[] | null = null;
    if (dto.tags !== undefined) {
      newTagRecords = await this.ensureTags(dto.tags);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (newTagRecords !== null) {
        await tx.portfolioItemTag.deleteMany({ where: { itemId: id } });
        if (newTagRecords.length > 0) {
          await tx.portfolioItemTag.createMany({
            data: newTagRecords.map((t) => ({ itemId: id, tagId: t.id })),
            skipDuplicates: true,
          });
        }
      }
      return tx.portfolioItem.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
          ...(newSlug ? { slug: newSlug } : {}),
          ...(dto.shortSummary !== undefined
            ? { shortSummary: dto.shortSummary }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.isNda !== undefined ? { isNda: dto.isNda } : {}),
          ...(dto.contentMarkdown !== undefined
            ? { contentMarkdown: dto.contentMarkdown }
            : {}),
          updatedById: actorId,
        },
        include: this.fullInclude(),
      });
    });

    const changes = safeDiff(
      {
        title: existing.title,
        slug: existing.slug,
        status: existing.status,
        isNda: existing.isNda,
        shortSummary: existing.shortSummary,
      },
      {
        title: updated.title,
        slug: updated.slug,
        status: updated.status,
        isNda: updated.isNda,
        shortSummary: updated.shortSummary,
      },
    );

    const nextTagKeys =
      newTagRecords !== null
        ? newTagRecords.map((t) => t.normalized).sort()
        : previousTagKeys;
    const tagsDiff =
      newTagRecords !== null &&
      JSON.stringify(previousTagKeys) !== JSON.stringify(nextTagKeys)
        ? {
            added: nextTagKeys.filter((t) => !previousTagKeys.includes(t)),
            removed: previousTagKeys.filter((t) => !nextTagKeys.includes(t)),
          }
        : undefined;

    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'CRM',
      action: markdownChanged
        ? 'portfolio.markdown.replaced'
        : tagsDiff
          ? 'portfolio.tags.changed'
          : 'portfolio.update',
      targetType: 'PortfolioItem',
      targetId: id,
      targetLabel: updated.title,
      targetHref: `/portfolio/${updated.slug}`,
      result: AuditResult.SUCCESS,
      changes: changes ?? null,
      metadata: {
        markdownChanged,
        tagsDiff: tagsDiff ?? null,
      },
    });
    return updated;
  }

  async archive(id: string, actorId: string) {
    const existing = await this.prisma.portfolioItem.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Portfolio item not found');
    await this.prisma.portfolioItem.update({
      where: { id },
      data: { status: PortfolioStatus.ARCHIVED, updatedById: actorId },
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'CRM',
      action: 'portfolio.archive',
      targetType: 'PortfolioItem',
      targetId: id,
      targetLabel: existing.title,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }

  async remove(id: string, actorId: string) {
    const existing = await this.prisma.portfolioItem.findUnique({
      where: { id },
      include: { assets: true },
    });
    if (!existing) throw new NotFoundException('Portfolio item not found');
    // Clean up assets from storage first.
    const bucket = StorageBucket.PORTFOLIO;
    for (const asset of existing.assets) {
      try {
        await this.storage.deleteByName(bucket, asset.storageKey);
      } catch (err) {
        this.logger.warn(
          `Could not delete asset ${asset.storageKey}: ${(err as Error).message}`,
        );
      }
    }
    await this.prisma.portfolioItem.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'CRM',
      action: 'portfolio.delete',
      targetType: 'PortfolioItem',
      targetId: id,
      targetLabel: existing.title,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }

  // ─── Tags ──────────────────────────────────────────────────────

  async listTags() {
    return this.prisma.portfolioTag.findMany({
      orderBy: { normalized: 'asc' },
      select: { id: true, normalized: true, displayName: true },
    });
  }

  /**
   * Normalize + upsert each tag, returning the created/matched rows.
   * `Next.js` and `next.js` and `NEXT.JS` collapse to one row.
   */
  private async ensureTags(
    rawTags: string[],
  ): Promise<{ id: string; normalized: string }[]> {
    const seen = new Set<string>();
    const upserts: Promise<{ id: string; normalized: string }>[] = [];
    for (const raw of rawTags) {
      const { normalized, displayName } = normalizeTag(raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      upserts.push(
        this.prisma.portfolioTag.upsert({
          where: { normalized },
          create: { normalized, displayName },
          update: { displayName }, // keep latest casing choice
          select: { id: true, normalized: true },
        }),
      );
    }
    return Promise.all(upserts);
  }

  private async resolveUniqueSlug(wanted: string, excludeId?: string): Promise<string> {
    const base = toSlug(wanted);
    let candidate = base;
    let i = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await this.prisma.portfolioItem.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!existing || existing.id === excludeId) return candidate;
      i += 1;
      candidate = `${base}-${i}`;
      if (i > 50) throw new BadRequestException('Could not derive a unique slug');
    }
  }

  // ─── Assets ────────────────────────────────────────────────────

  async uploadAsset(
    itemId: string,
    file: { originalName: string; buffer: Buffer; mimeType: string },
    kind: PortfolioAssetKind,
    actorId: string,
  ) {
    const item = await this.prisma.portfolioItem.findUnique({
      where: { id: itemId },
      include: { coverAsset: true },
    });
    if (!item) throw new NotFoundException('Portfolio item not found');
    await this.assertUploadWithinLimits(itemId, kind, file.buffer.length);
    const bucket = StorageBucket.PORTFOLIO;
    const safeName = file.originalName.replace(/[^\p{L}\p{N}._\-]/gu, '_');
    const storageKey = await this.buildStorageKey(itemId, kind, safeName);
    await this.storage.upload({
      bucket,
      fileName: storageKey,
      buffer: file.buffer,
      mimeType: file.mimeType,
    });

    // The new object is now in B2 — if the DB-side create or
    // coverAssetId swap fails, we must drop the orphan from the
    // bucket. Also keeps the previous cover file around until the
    // replacement is fully committed.
    let asset;
    try {
      asset = await this.prisma.portfolioAsset.create({
        data: {
          itemId,
          kind,
          fileName: file.originalName,
          storageKey,
          mimeType: file.mimeType,
          size: file.buffer.length,
        },
      });
      if (kind === PortfolioAssetKind.COVER) {
        await this.prisma.portfolioItem.update({
          where: { id: itemId },
          data: { coverAssetId: asset.id },
        });
      }
    } catch (err) {
      try {
        await this.storage.deleteByName(bucket, storageKey);
      } catch (cleanupErr) {
        this.logger.warn(
          `Orphan cleanup: could not delete ${storageKey}: ${
            (cleanupErr as Error).message
          }`,
        );
      }
      throw err;
    }

    // Only AFTER the DB write succeeded, retire the old cover file
    // (if any). We never touch a working object before replacement
    // is committed.
    if (kind === PortfolioAssetKind.COVER && item.coverAsset) {
      const previous = item.coverAsset;
      try {
        await this.storage.deleteByName(bucket, previous.storageKey);
      } catch (err) {
        this.logger.warn(
          `Previous cover ${previous.storageKey} delete failed: ${
            (err as Error).message
          }`,
        );
      }
      try {
        await this.prisma.portfolioAsset.delete({ where: { id: previous.id } });
      } catch (err) {
        this.logger.warn(
          `Previous cover row ${previous.id} delete failed: ${
            (err as Error).message
          }`,
        );
      }
    }
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'CRM',
      action: 'portfolio.asset.upload',
      targetType: 'PortfolioAsset',
      targetId: asset.id,
      targetLabel: file.originalName,
      result: AuditResult.SUCCESS,
      metadata: { kind, itemId, size: file.buffer.length },
    });
    return asset;
  }

  async signAssetDownload(assetId: string): Promise<string> {
    // Load the asset together with its owning item so we can enforce
    // that the asset is attached to a reachable record. A row without
    // an `item` (dangling after a race during item delete) must not
    // produce a signed URL.
    const asset = await this.prisma.portfolioAsset.findUnique({
      where: { id: assetId },
      include: { item: { select: { id: true } } },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    if (!asset.item) throw new NotFoundException('Asset not found');
    return this.storage.getDownloadUrl(
      StorageBucket.PORTFOLIO,
      asset.storageKey,
    );
  }

  async removeAsset(assetId: string, actorId: string) {
    const asset = await this.prisma.portfolioAsset.findUnique({
      where: { id: assetId },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    const bucket = StorageBucket.PORTFOLIO;
    try {
      await this.storage.deleteByName(bucket, asset.storageKey);
    } catch (err) {
      this.logger.warn(
        `Asset ${asset.storageKey} delete failed: ${(err as Error).message}`,
      );
    }
    await this.prisma.portfolioAsset.delete({ where: { id: assetId } });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'CRM',
      action: 'portfolio.asset.delete',
      targetType: 'PortfolioAsset',
      targetId: assetId,
      targetLabel: asset.fileName,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }

  /** Mark that a PDF export happened for audit. */
  async recordExport(itemId: string, actorId: string) {
    const item = await this.prisma.portfolioItem.findUnique({
      where: { id: itemId },
      select: { title: true, slug: true },
    });
    if (!item) throw new NotFoundException('Portfolio item not found');
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'CRM',
      action: 'portfolio.export',
      targetType: 'PortfolioItem',
      targetId: itemId,
      targetLabel: item.title,
      targetHref: `/portfolio/${item.slug}`,
      result: AuditResult.SUCCESS,
    });
  }

  // ─── Includes ──────────────────────────────────────────────────

  private listInclude(): Prisma.PortfolioItemInclude {
    return {
      tags: { include: { tag: true } },
      coverAsset: true,
      _count: { select: { assets: true } },
    };
  }

  private fullInclude(): Prisma.PortfolioItemInclude {
    return {
      tags: { include: { tag: true } },
      coverAsset: true,
      assets: { orderBy: { createdAt: 'asc' } },
    };
  }

  // ─── Settings-driven feature flags ─────────────────────────────

  async isPdfExportEnabled(): Promise<boolean> {
    return this.settings.getBooleanForKey(
      SK.PORTFOLIO_PDF_EXPORT_ENABLED,
      true,
    );
  }
}
