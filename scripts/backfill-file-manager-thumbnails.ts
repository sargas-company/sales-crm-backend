#!/usr/bin/env ts-node
/**
 * File-manager thumbnail backfill — one-shot.
 *
 * Generates WebP preview thumbnails for every FileManagerFile row
 * whose `mimeType` is a supported image type and whose `thumbnailKey`
 * is still NULL. Idempotent — rows that already carry a `thumbnailKey`
 * are untouched.
 *
 * Safe on any environment, including production: only *adds* new
 * thumbnail objects to B2 and sets the nullable `thumbnailKey`
 * column. No existing file bytes are read-only-except-once, no
 * destructive operations.
 *
 *   # Dry-run (reports how many would be processed, writes nothing):
 *   npx ts-node scripts/backfill-file-manager-thumbnails.ts
 *   make data-dry-run SCRIPT=backfill-file-manager-thumbnails
 *
 *   # Apply (actually generates and persists):
 *   npx ts-node scripts/backfill-file-manager-thumbnails.ts --apply
 *   make data-apply SCRIPT=backfill-file-manager-thumbnails
 *
 * On a failed row (B2 404, decode error, oversize source, etc.) the
 * script logs the id + name and continues; one bad file never blocks
 * the rest. Re-running the script later is safe — only still-NULL
 * rows get a second attempt.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { FileManagerThumbnailService } from '../src/file-manager/file-manager-thumbnail.service';

const BATCH = 100;

async function main() {
  const apply = process.argv.includes('--apply');
  /* `--force` walks every image row (including those that already
   * carry a thumbnailKey) and regenerates — needed when the
   * thumbnail size or quality knob in FileManagerThumbnailService
   * has changed and the existing thumbs should be replaced. Thumbs
   * use a deterministic key (`thumbs/<fileId>.webp`), so B2 simply
   * overwrites — no orphans. */
  const force = process.argv.includes('--force');
  const tag = apply
    ? `[thumb-backfill${force ? ' FORCE' : ''}]`
    : `[thumb-backfill DRY-RUN${force ? ' FORCE' : ''}]`;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  const prisma = app.get(PrismaService);
  const thumbnails = app.get(FileManagerThumbnailService);

  let examined = 0;
  let generated = 0;
  let skippedIneligible = 0;
  let failed = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.fileManagerFile.findMany({
      where: {
        mimeType: { startsWith: 'image/' },
        ...(force ? {} : { thumbnailKey: null }),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      select: {
        id: true,
        mimeType: true,
        storageKey: true,
        originalName: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      examined++;
      if (!thumbnails.isEligible(row.mimeType)) {
        skippedIneligible++;
        continue;
      }
      if (!apply) continue;
      const key = await thumbnails.generate(row.id, row.mimeType, {
        storageKey: row.storageKey,
      });
      if (key) {
        generated++;
      } else {
        failed++;
        console.warn(
          `${tag} failed id=${row.id} name=${row.originalName}`,
        );
      }
    }
    console.log(
      `${tag} examined=${examined} generated=${generated} skippedIneligible=${skippedIneligible} failed=${failed}`,
    );
  }

  console.log(
    `${tag} DONE examined=${examined} generated=${generated} skippedIneligible=${skippedIneligible} failed=${failed}`,
  );
  if (!apply) {
    const eligible = examined - skippedIneligible;
    console.log(
      `${tag} ${eligible} row(s) would be processed. Re-run with --apply.`,
    );
  }

  /* All work (B2 uploads + DB updates) is already persisted at this
   * point. We deliberately skip `app.close()` and hard-exit instead:
   * BullMQ workers inside AppModule keep ioredis connections open
   * and, on graceful teardown, synchronously throw "Connection is
   * closed" from an event-emitter handler — bypasses promise .catch
   * and crashes the process with exit 1. Postgres and B2 don't care
   * about abruptly-closed sockets; the OS reaps the handles. */
  process.exit(0);
}

main().catch((err) => {
  console.error('[thumb-backfill] fatal', err);
  process.exit(1);
});
