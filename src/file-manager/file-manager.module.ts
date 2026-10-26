import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { FileManagerAccessService } from './file-manager-access.service';
import { FileManagerController } from './file-manager.controller';
import { FileManagerService } from './file-manager.service';
import { FileManagerShareController } from './file-manager-share.controller';
import { FileManagerShareService } from './file-manager-share.service';
import { UploadSessionService } from './upload-session.service';
import { UploadSessionCron } from './upload-session.cron';

/* Standalone corporate file space — no FK to Project / Client /
 * Employee / anything else by owner's explicit rule. Thin wrapper
 * around StorageService (B2) plus a nested folder tree in Postgres.
 * UploadSessionService + cron back the resumable upload path.
 * FileManagerShareService + controller back the portal / shares /
 * invites surface (admin side). */
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [FileManagerController, FileManagerShareController],
  providers: [
    FileManagerService,
    UploadSessionService,
    UploadSessionCron,
    FileManagerShareService,
    FileManagerAccessService,
  ],
  exports: [FileManagerAccessService],
})
export class FileManagerModule {}
