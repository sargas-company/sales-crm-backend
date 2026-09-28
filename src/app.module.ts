import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { HealthController } from './common/http/health.controller';

import { DatabaseBackupModule } from './database-backup/database-backup.module';

import { StorageModule } from './storage/storage.module';

import { AccountModule } from './account/account.module';
import { ClientCallsModule } from './client-calls/client-calls.module';
import { AuthModule } from './auth/auth.module';
import { ClientRequestsModule } from './client-requests/client-requests.module';
import { CounterpartyModule } from './counterparty/counterparty.module';
import { InvoiceModule } from './invoice/invoice.module';
import { SettingsModule } from './settings/settings.module';
import { PlatformModule } from './platform/platform.module';
import { AnthropicModule } from './anthropic/anthropic.module';
import { JobPostModule } from './job-post/job-post.module';
import { LeadModule } from './lead/lead.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProposalModule } from './proposal/proposal.module';
import { PromptModule } from './prompt/prompt.module';
import { AuditLogModule } from './audit/audit-log.module';
import { RolesModule } from './roles/roles.module';
import { VibeWorkerWebhookModule } from './webhooks/vibe-worker/vibe-worker.module';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    AnthropicModule,
    StorageModule,
    DatabaseBackupModule,
    PrismaModule,
    AuditLogModule,
    AuthModule,
    RolesModule,
    PlatformModule,
    AccountModule,
    ProposalModule,
    PromptModule,
    LeadModule,
    JobPostModule,
    ClientRequestsModule,
    InvoiceModule,
    CounterpartyModule,
    ClientCallsModule,
    SettingsModule,
    VibeWorkerWebhookModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
