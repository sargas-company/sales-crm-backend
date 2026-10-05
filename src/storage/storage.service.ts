import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import B2 = require('backblaze-b2');

import {
  StorageBucket,
  StorageUploadOptions,
  StorageUploadResult,
} from './storage.types';

interface BucketConfig {
  id: string;
  name: string;
}

interface UploadUrlEntry {
  uploadUrl: string;
  authToken: string;
  expiresAt: number;
}

const UPLOAD_URL_TTL_MS = 23 * 60 * 60 * 1000;

/**
 * Default per-bucket signed-URL TTLs (seconds). Each entry can be
 * overridden by the matching `B2_SIGNED_TTL_<BUCKET>_SECONDS` env var.
 *
 * - AVATARS: 24h — avatars are tiny, change rarely, and the UI shows
 *   them on every page.
 * - PORTFOLIO / CLIENT_REQUESTS / INVOICES: 15m — opened on demand,
 *   downloaded once.
 * - DB_DUMPS: not exposed through user endpoints in the MVP, kept
 *   here only so service helpers do not need a special case.
 */
const DEFAULT_TTL_SECONDS: Record<StorageBucket, number> = {
  [StorageBucket.AVATARS]: 24 * 60 * 60,
  [StorageBucket.PORTFOLIO]: 15 * 60,
  [StorageBucket.CLIENT_REQUESTS]: 15 * 60,
  [StorageBucket.INVOICES]: 15 * 60,
  [StorageBucket.DB_DUMPS]: 15 * 60,
};

const TTL_ENV_KEY: Record<StorageBucket, string> = {
  [StorageBucket.AVATARS]: 'B2_SIGNED_TTL_AVATARS_SECONDS',
  [StorageBucket.PORTFOLIO]: 'B2_SIGNED_TTL_PORTFOLIO_SECONDS',
  [StorageBucket.CLIENT_REQUESTS]: 'B2_SIGNED_TTL_CLIENT_REQUESTS_SECONDS',
  [StorageBucket.INVOICES]: 'B2_SIGNED_TTL_INVOICES_SECONDS',
  [StorageBucket.DB_DUMPS]: 'B2_SIGNED_TTL_DB_DUMPS_SECONDS',
};

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly b2: B2;
  private readonly uploadUrlCache = new Map<string, UploadUrlEntry>();
  private downloadUrl!: string;

  constructor(private readonly config: ConfigService) {
    this.b2 = new B2({
      applicationKeyId: config.getOrThrow<string>('B2_KEY_ID'),
      applicationKey: config.getOrThrow<string>('B2_APP_KEY'),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.authorize();
  }

  async upload(options: StorageUploadOptions): Promise<StorageUploadResult> {
    const bucket = this.getBucketConfig(options.bucket);
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { uploadUrl, authToken } = await this.getUploadUrl(bucket.id);

        const { data } = await this.b2.uploadFile({
          uploadUrl,
          uploadAuthToken: authToken,
          fileName: options.fileName,
          data: options.buffer,
          mime: options.mimeType,
          contentLength: options.buffer.length,
        });

        return {
          fileId: data.fileId,
          key: options.fileName,
        };
      } catch (err: unknown) {
        lastError = err;
        this.uploadUrlCache.delete(bucket.id);

        const status =
          (err as { response?: { status?: number } }).response?.status ??
          (err as { status?: number }).status;
        if (attempt === 0 && (status === 401 || status === 503)) {
          if (status === 401) await this.authorize();
          continue;
        }
        break;
      }
    }

    const msg = (lastError as { message?: string })?.message ?? String(lastError);
    throw new InternalServerErrorException(
      `B2 upload failed for "${options.fileName}": ${msg}`,
    );
  }

  async replace(options: StorageUploadOptions): Promise<StorageUploadResult> {
    await this.deleteByName(options.bucket, options.fileName);
    return this.upload(options);
  }

  async delete(fileId: string, fileName: string): Promise<void> {
    await this.b2.deleteFileVersion({ fileId, fileName });
  }

  async deleteByName(bucket: StorageBucket, fileName: string): Promise<void> {
    const { id: bucketId } = this.getBucketConfig(bucket);
    const { data } = await this.b2.listFileVersions({
      bucketId,
      startFileName: fileName,
      maxFileCount: 10,
    });
    const versions = data.files.filter((f) => f.fileName === fileName);
    await Promise.allSettled(
      versions.map((f) =>
        this.b2.deleteFileVersion({ fileId: f.fileId, fileName: f.fileName }),
      ),
    );
  }

  async deleteFolder(bucket: StorageBucket, prefix: string): Promise<void> {
    const { id: bucketId } = this.getBucketConfig(bucket);
    let startFileName: string | undefined;
    let startFileId: string | undefined;

    do {
      const { data } = await this.b2.listFileVersions({
        bucketId,
        prefix,
        startFileName,
        startFileId,
        maxFileCount: 1000,
      });
      await Promise.allSettled(
        data.files.map((f) =>
          this.b2.deleteFileVersion({
            fileId: f.fileId,
            fileName: f.fileName,
          }),
        ),
      );
      startFileName = data.nextFileName ?? undefined;
      startFileId = data.nextFileId ?? undefined;
    } while (startFileName);
  }

  /**
   * Returns a short-lived download URL for the given key. Defaults to
   * the bucket's configured TTL; callers may override.
   */
  async getDownloadUrl(
    bucket: StorageBucket,
    fileName: string,
    expiresInSeconds?: number,
  ): Promise<string> {
    const ttl = Math.max(1, expiresInSeconds ?? this.getBucketTtl(bucket));
    const { id: bucketId, name: bucketName } = this.getBucketConfig(bucket);

    const { data } = await this.b2.getDownloadAuthorization({
      bucketId,
      fileNamePrefix: fileName,
      validDurationInSeconds: ttl,
    });

    return `${this.downloadUrl}/file/${bucketName}/${this.encodePath(
      fileName,
    )}?Authorization=${data.authorizationToken}`;
  }

  /**
   * Legacy helper: given a URL in the format
   * `https://…/file/<bucket>/<key>[?Authorization=…]`, pull back the
   * original object key (fully decoded, preserving the full path).
   * Returns null when the URL does not match that format — in which
   * case the caller should treat the input as either an opaque key or
   * as unknown data.
   */
  extractKeyFromLegacyUrl(input: string): string | null {
    if (!input) return null;
    const marker = '/file/';
    const idx = input.indexOf(marker);
    if (idx < 0) return null;
    // Strip query string first — Authorization token must not become
    // part of the key.
    const noQuery = input.split('?')[0];
    const rest = noQuery.slice(idx + marker.length);
    // Shape: `<bucket>/<key>` where <key> may contain '/'.
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const encodedKey = rest.slice(slash + 1);
    if (!encodedKey) return null;
    try {
      return encodedKey
        .split('/')
        .map((seg) => decodeURIComponent(seg))
        .join('/');
    } catch {
      return null;
    }
  }

  private getBucketTtl(bucket: StorageBucket): number {
    const envKey = TTL_ENV_KEY[bucket];
    const raw = this.config.get<string | number>(envKey);
    const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return DEFAULT_TTL_SECONDS[bucket];
  }

  private async authorize(): Promise<void> {
    const response = await this.b2.authorize();
    this.downloadUrl =
      this.config.get<string>('B2_DOWNLOAD_URL') || response.data.downloadUrl;
    this.logger.log('Backblaze B2 authorized');
  }

  private async getUploadUrl(
    bucketId: string,
  ): Promise<{ uploadUrl: string; authToken: string }> {
    const cached = this.uploadUrlCache.get(bucketId);
    if (cached && cached.expiresAt > Date.now()) {
      // consume the entry so concurrent uploads each get their own URL
      this.uploadUrlCache.delete(bucketId);
      return { uploadUrl: cached.uploadUrl, authToken: cached.authToken };
    }

    const { data } = await this.b2.getUploadUrl({ bucketId });
    return { uploadUrl: data.uploadUrl, authToken: data.authorizationToken };
  }

  private encodePath(filePath: string): string {
    return filePath.split('/').map(encodeURIComponent).join('/');
  }

  /**
   * Resolve a bucket's `{id, name}` lazily so a missing env var only
   * blows up at the first touch of THAT bucket, not at app boot. A
   * clear InternalServerErrorException is surfaced instead of Nest's
   * default "Expected to find a value" message, with the bucket name
   * included so ops can grep the right env var.
   */
  private getBucketConfig(bucket: StorageBucket): BucketConfig {
    const envKeys: Record<StorageBucket, { id: string; name: string }> = {
      [StorageBucket.INVOICES]: {
        id: 'B2_BUCKET_INVOICES_ID',
        name: 'B2_BUCKET_INVOICES_NAME',
      },
      [StorageBucket.CLIENT_REQUESTS]: {
        id: 'B2_BUCKET_CLIENT_REQUESTS_ID',
        name: 'B2_BUCKET_CLIENT_REQUESTS_NAME',
      },
      [StorageBucket.DB_DUMPS]: {
        id: 'B2_BUCKET_DB_DUMPS_ID',
        name: 'B2_BUCKET_DB_DUMPS_NAME',
      },
      [StorageBucket.PORTFOLIO]: {
        id: 'B2_BUCKET_PORTFOLIO_ID',
        name: 'B2_BUCKET_PORTFOLIO_NAME',
      },
      [StorageBucket.AVATARS]: {
        id: 'B2_BUCKET_AVATARS_ID',
        name: 'B2_BUCKET_AVATARS_NAME',
      },
    };
    const keys = envKeys[bucket];
    const id = this.config.get<string>(keys.id);
    const name = this.config.get<string>(keys.name);
    if (!id || !name) {
      throw new InternalServerErrorException(
        `Storage bucket "${bucket}" is not configured — set ${keys.id} and ${keys.name} in the environment. There is intentionally no fallback to a legacy bucket.`,
      );
    }
    return { id, name };
  }
}
