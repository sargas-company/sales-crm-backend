import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import B2 from 'backblaze-b2';

import { resolveBackupB2Credentials } from './backup-credentials';

/**
 * Signed-URL issuer for backup artifacts.
 *
 * Deliberately isolated from the runtime `StorageService`: per the
 * project policy in `backup-credentials.ts`, the backend runtime key
 * (`B2_KEY_ID` / `B2_APP_KEY`) must NEVER touch the DB dumps bucket.
 * Downloads use the same `B2_BACKUP_KEY_ID` / `B2_BACKUP_APP_KEY`
 * pair that writes backups — these keys are scoped to the DB dumps
 * bucket only, so a leak of a signed URL can at worst expose dumps,
 * not user content.
 *
 * Authorization is lazy and cached in-memory; a 24-hour expiry
 * matches B2's own authorization token lifetime, re-authorized on
 * demand.
 */
@Injectable()
export class BackupDownloadService {
  private readonly logger = new Logger(BackupDownloadService.name);
  private b2: B2 | null = null;
  private downloadUrl = '';
  private authorizedAt = 0;
  private readonly AUTH_TTL_MS = 23 * 60 * 60 * 1000;

  async getSignedUrl(fileName: string, ttlSeconds: number): Promise<string> {
    await this.ensureAuthorized();
    const bucketId = process.env.B2_BUCKET_DB_DUMPS_ID;
    const bucketName = process.env.B2_BUCKET_DB_DUMPS_NAME;
    if (!bucketId || !bucketName) {
      throw new InternalServerErrorException(
        'B2_BUCKET_DB_DUMPS_ID / B2_BUCKET_DB_DUMPS_NAME are not configured',
      );
    }
    const { data } = await this.b2!.getDownloadAuthorization({
      bucketId,
      fileNamePrefix: fileName,
      validDurationInSeconds: ttlSeconds,
    });
    const encoded = fileName.split('/').map(encodeURIComponent).join('/');
    return `${this.downloadUrl}/file/${bucketName}/${encoded}?Authorization=${data.authorizationToken}`;
  }

  private async ensureAuthorized(): Promise<void> {
    if (this.b2 && Date.now() - this.authorizedAt < this.AUTH_TTL_MS) {
      return;
    }
    const creds = resolveBackupB2Credentials(process.env);
    this.b2 = new B2({
      applicationKeyId: creds.keyId,
      applicationKey: creds.appKey,
    });
    const response = await this.b2.authorize();
    this.downloadUrl =
      process.env.B2_DOWNLOAD_URL || response.data.downloadUrl;
    this.authorizedAt = Date.now();
    this.logger.log(
      `Backup B2 download client authorized (fallback=${creds.usedFallback})`,
    );
  }
}
