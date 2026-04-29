import { Injectable, InternalServerErrorException, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import B2 from 'backblaze-b2';

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
          url: `${this.downloadUrl}/file/${bucket.name}/${options.fileName}`,
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

  async delete(fileId: string, fileName: string): Promise<void> {
    await this.b2.deleteFileVersion({ fileId, fileName });
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
      return { uploadUrl: cached.uploadUrl, authToken: cached.authToken };
    }

    const { data } = await this.b2.getUploadUrl({ bucketId });
    this.uploadUrlCache.set(bucketId, {
      uploadUrl: data.uploadUrl,
      authToken: data.authorizationToken,
      expiresAt: Date.now() + UPLOAD_URL_TTL_MS,
    });

    return { uploadUrl: data.uploadUrl, authToken: data.authorizationToken };
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
