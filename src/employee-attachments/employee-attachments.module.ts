import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { EmployeeAttachmentsController } from './employee-attachments.controller';
import { EmployeeAttachmentsService } from './employee-attachments.service';

/**
 * Simple module: controller + service, pulled into the app alongside
 * AuthModule (for Jwt/Permission guards) and StorageModule (for the
 * shared Backblaze client + signed-URL helper). Prisma and
 * AuditEventService come from their globally-registered modules.
 */
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [EmployeeAttachmentsController],
  providers: [EmployeeAttachmentsService],
})
export class EmployeeAttachmentsModule {}
