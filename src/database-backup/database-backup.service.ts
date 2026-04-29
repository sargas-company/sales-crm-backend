import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { exec } from 'child_process';
import { promisify } from 'util';

import { StorageBucket } from '../storage/storage.types';
import { StorageService } from '../storage/storage.service';

const execAsync = promisify(exec);

@Injectable()
export class DatabaseBackupService {
  private readonly logger = new Logger(DatabaseBackupService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async runBackup(): Promise<void> {
    this.logger.log('Starting database backup...');

    try {
      const buffer = await this.createDump();
      const fileName = this.buildFileName();

      await this.storage.upload({
        bucket: StorageBucket.DB_DUMPS,
        fileName,
        buffer,
        mimeType: 'application/octet-stream',
      });

      this.logger.log(`Database backup uploaded: ${fileName} (${buffer.length} bytes)`);
    } catch (err: any) {
      this.logger.error(`Database backup failed: ${err.message}`, err.stack);
      throw err;
    }
  }

  private async createDump(): Promise<Buffer> {
    const url = this.config.getOrThrow<string>('DATABASE_URL');
    const parsed = new URL(url);

    const host = parsed.hostname;
    const port = parsed.port || '5432';
    const database = parsed.pathname.replace(/^\//, '');
    const user = parsed.username;
    const password = decodeURIComponent(parsed.password);

    const env = { ...process.env, PGPASSWORD: password };

    const bin = this.config.get<string>('PG_DUMP_BIN') || 'pg_dump';
    // -Fc = custom compressed format, best for pg_restore
    const cmd = `${bin} -h ${host} -p ${port} -U ${user} -Fc ${database}`;

    const { stdout } = await execAsync(cmd, { env, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });

    return stdout as unknown as Buffer;
  }

  private buildFileName(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy}.dump`;
  }
}
