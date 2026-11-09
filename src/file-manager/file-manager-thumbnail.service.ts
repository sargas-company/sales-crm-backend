import { Injectable, Logger } from '@nestjs/common';
/* `import sharp from 'sharp'` compiles to `sharp_1.default(…)` under
 * this project's tsconfig (no esModuleInterop); sharp's package is
 * exported as `module.exports = fn`, so `.default` is undefined and
 * every call throws "sharp_1.default is not a function" at runtime.
 * The TS `import = require` form compiles to a plain `const sharp =
 * require('sharp')`, which calls the function directly. */
import sharp = require('sharp');
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { StorageBucket } from '../storage/storage.types';

/**
 * Standalone service that owns the file-manager preview thumbnails.
 * Called from both upload paths (single-shot in FileManagerService
 * and resumable finalize in UploadSessionService) and from the
 * one-off backfill script.
 *
 * Contract: `generate()` never throws. On any failure the file row's
 * `thumbnailKey` stays NULL and the UI falls back to the standard
 * file-type icon — the exact same visual state as a non-image or a
 * pre-backfill legacy row.
 */

/* 512×512 keeps text and UI detail crisp when the browser downscales
 * to the list tile — 256@q75 was legible for photos but the chain of
 * two lossy resamples smeared screenshots. 512@q85 lands around
 * 30-50 KB per thumb, still trivial for B2 egress. */
const THUMB_EDGE_PX = 512;
const THUMB_QUALITY = 85;

/* Skip sources larger than 25 MB: sharp decodes the whole frame into
 * memory before resizing, and a RAW/panorama JPEG beyond that is not
 * worth the memory spike for a 256-px tile. The UI falls back to the
 * icon exactly like a thumbnail-generation failure would. */
const THUMB_MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/* MIME types we attempt. HEIC covers iPhone photos; sharp supports it
 * when libvips is built with it, which is the case for the sharp
 * prebuilt binaries. If not supported at runtime, sharp throws, we
 * catch, UI falls back. */
const THUMB_MIME_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/avif',
  'image/heic',
]);

@Injectable()
export class FileManagerThumbnailService {
  private readonly logger = new Logger(FileManagerThumbnailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Convention: `thumbs/<fileId>.webp` in the same bucket as the
   *  source. Delete flow uses the stored value directly, so a future
   *  format change does not strand legacy keys. */
  thumbKey(fileId: string): string {
    return `thumbs/${fileId}.webp`;
  }

  isEligible(mimeType: string): boolean {
    return THUMB_MIME_TYPES.has(mimeType.toLowerCase());
  }

  /**
   * Resize → encode → upload → persist the key on the file row. When
   * the caller already has the source bytes in memory (single-shot
   * upload path), pass `{ buffer }` to skip the B2 download round-
   * trip. Otherwise pass `{ storageKey }` and the source is pulled
   * from B2.
   *
   * Returns the stored thumbnail key on success, or NULL for a skip
   * (ineligible mime / oversize source) or any failure.
   */
  async generate(
    fileId: string,
    mimeType: string,
    source: { buffer: Buffer } | { storageKey: string },
  ): Promise<string | null> {
    if (!this.isEligible(mimeType)) return null;
    try {
      const buffer =
        'buffer' in source
          ? source.buffer
          : await this.storage.downloadBuffer(
              StorageBucket.FILE_MANAGER,
              source.storageKey,
            );

      if (buffer.length > THUMB_MAX_SOURCE_BYTES) {
        this.logger.warn(
          `[thumbnails] skipping ${fileId}: source ${buffer.length} bytes exceeds ${THUMB_MAX_SOURCE_BYTES}`,
        );
        return null;
      }

      const thumbBuffer = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize(THUMB_EDGE_PX, THUMB_EDGE_PX, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: THUMB_QUALITY })
        .toBuffer();

      const key = this.thumbKey(fileId);
      await this.storage.upload({
        bucket: StorageBucket.FILE_MANAGER,
        fileName: key,
        buffer: thumbBuffer,
        mimeType: 'image/webp',
      });

      await this.prisma.fileManagerFile.update({
        where: { id: fileId },
        data: { thumbnailKey: key },
      });

      return key;
    } catch (err) {
      const msg = (err as Error).message || 'unknown';
      this.logger.warn(
        `[thumbnails] generate failed for ${fileId}: ${msg}`,
      );
      return null;
    }
  }

  /** Remove the thumb object from B2. Missing-object errors are
   *  swallowed — the caller is already tearing the parent file down
   *  and a missing thumb is not worth failing the delete. */
  async deleteObject(key: string | null | undefined): Promise<void> {
    if (!key) return;
    try {
      await this.storage.deleteByName(StorageBucket.FILE_MANAGER, key);
    } catch (err) {
      const msg = (err as Error).message || 'B2 delete failed';
      if (!/not found|404/i.test(msg)) {
        this.logger.warn(
          `[thumbnails] B2 delete stuck for ${key}: ${msg}`,
        );
      }
    }
  }
}
