import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { ProjectAttachmentsController } from './project-attachments.controller';
import { ProjectAttachmentsService } from './project-attachments.service';

/**
 * Mirror of EmployeeAttachmentsModule — same shape, same deps: controller
 * + service, with AuthModule for guards and StorageModule for the shared
 * Backblaze client. Prisma and AuditEventService come from their
 * globally-registered modules.
 */
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [ProjectAttachmentsController],
  providers: [ProjectAttachmentsService],
})
export class ProjectAttachmentsModule {}
