import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditEventController } from './audit-event.controller';
import { AuditLogController } from './audit-log.controller';
import { AuditEventService } from './audit-event.service';

/**
 * Global module: write side (`AuditEventService`) + read side
 * (`AuditEventController` for the legacy credentials-scoped `/audit-events`
 * endpoint and `AuditLogController` for the richer `/audit-log/*` API
 * the frontend Audit Log pages talk to). AuthModule is imported so
 * the controllers' `JwtAuthGuard`/`PermissionGuard` resolve.
 */
@Global()
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AuditEventController, AuditLogController],
  providers: [AuditEventService],
  exports: [AuditEventService],
})
export class AuditEventModule {}
