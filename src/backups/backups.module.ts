import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuditEventModule } from '../audit-event/audit-event.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BackupDownloadService } from './backup-download.service';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';

@Module({
  imports: [AuthModule, PrismaModule, AuditEventModule],
  controllers: [BackupsController],
  providers: [BackupsService, BackupDownloadService],
  exports: [BackupsService],
})
export class BackupsModule {}
