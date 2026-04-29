import { Injectable, InternalServerErrorException, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import B2 = require('backblaze-b2');

import { StorageBucket, StorageUploadOptions, StorageUploadResult } from './storage.types';

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

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly b2: B2;
  private readonly uploadUrlCache = new Map<string, UploadUrlEntry>();
  private downloadUrl: string;

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
          url: `${this.downloadUrl}/file/${bucket.name}/${this.encodePath(options.fileName)}`,
        };
      } catch (err: any) {
        lastError = err;
        this.uploadUrlCache.delete(bucket.id);

        const status = err?.response?.status ?? err?.status;
        if (attempt === 0 && (status === 401 || status === 503)) {
          if (status === 401) await this.authorize();
          continue;
        }
        break;
      }
    }

    const msg = (lastError as any)?.message ?? String(lastError);
    throw new InternalServerErrorException(`B2 upload failed for "${options.fileName}": ${msg}`);
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
    const { data } = await this.b2.listFileVersions({ bucketId, startFileName: fileName, maxFileCount: 10 });
    const versions = data.files.filter((f) => f.fileName === fileName);
    await Promise.allSettled(versions.map((f) => this.b2.deleteFileVersion({ fileId: f.fileId, fileName: f.fileName })));
  }

  async deleteFolder(bucket: StorageBucket, prefix: string): Promise<void> {
    const { id: bucketId } = this.getBucketConfig(bucket);
    let startFileName: string | undefined;
    let startFileId: string | undefined;

    do {
      const { data } = await this.b2.listFileVersions({ bucketId, prefix, startFileName, startFileId, maxFileCount: 1000 });
      await Promise.allSettled(
        data.files.map((f) => this.b2.deleteFileVersion({ fileId: f.fileId, fileName: f.fileName })),
      );
      startFileName = data.nextFileName ?? undefined;
      startFileId = data.nextFileId ?? undefined;
    } while (startFileName);
  }

  async getDownloadUrl(
    bucket: StorageBucket,
    fileName: string,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const { id: bucketId, name: bucketName } = this.getBucketConfig(bucket);

    const { data } = await this.b2.getDownloadAuthorization({
      bucketId,
      fileNamePrefix: fileName,
      validDurationInSeconds: expiresInSeconds,
    });

    return `${this.downloadUrl}/file/${bucketName}/${this.encodePath(fileName)}?Authorization=${data.authorizationToken}`;
  }

  private async authorize(): Promise<void> {
    const response = await this.b2.authorize();
    this.downloadUrl =
      this.config.get<string>('B2_DOWNLOAD_URL') || response.data.downloadUrl;
    this.logger.log('Backblaze B2 authorized');
  }

  private async getUploadUrl(bucketId: string): Promise<{ uploadUrl: string; authToken: string }> {
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

  private getBucketConfig(bucket: StorageBucket): BucketConfig {
    const configs: Record<StorageBucket, BucketConfig> = {
      [StorageBucket.INVOICES]: {
        id: this.config.getOrThrow<string>('B2_BUCKET_INVOICES_ID'),
        name: this.config.getOrThrow<string>('B2_BUCKET_INVOICES_NAME'),
      },
      [StorageBucket.CLIENT_REQUESTS]: {
        id: this.config.getOrThrow<string>('B2_BUCKET_CLIENT_REQUESTS_ID'),
        name: this.config.getOrThrow<string>('B2_BUCKET_CLIENT_REQUESTS_NAME'),
      },
      [StorageBucket.DB_DUMPS]: {
        id: this.config.getOrThrow<string>('B2_BUCKET_DB_DUMPS_ID'),
        name: this.config.getOrThrow<string>('B2_BUCKET_DB_DUMPS_NAME'),
      },
    };
    return configs[bucket];
  }
}
