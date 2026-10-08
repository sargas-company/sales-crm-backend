import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { HealthController } from './common/http/health.controller';

import { StorageModule } from './storage/storage.module';

import { AccountModule } from './account/account.module';
import { ClientCallsModule } from './client-calls/client-calls.module';
import { AuthModule } from './auth/auth.module';
import { ClientRequestsModule } from './client-requests/client-requests.module';
import { ClientModule } from './client/client.module';
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
import { AuditEventModule } from './audit-event/audit-event.module';
import { PhoneNumbersModule } from './phone-numbers/phone-numbers.module';
import { PhoneServicesModule } from './phone-services/phone-services.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { BackupsModule } from './backups/backups.module';
import { CredentialsVaultModule } from './credentials-vault/credentials-vault.module';
import { CredentialsModule } from './credentials/credentials.module';
import { RolesModule } from './roles/roles.module';
import { VibeWorkerWebhookModule } from './webhooks/vibe-worker/vibe-worker.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { EmployeeModule } from './employee/employee.module';
import { ProjectModule } from './project/project.module';
import { ProjectReportModule } from './project-report/project-report.module';
import { TimeOffModule } from './time-off/time-off.module';
import { PayrollModule } from './payroll/payroll.module';
import { SalaryReviewModule } from './salary-review/salary-review.module';
import { PaymentSourceModule } from './payment-source/payment-source.module';
import { CompensationAnalyticsModule } from './compensation-analytics/compensation-analytics.module';
import { LinkedInAccountModule } from './linkedin-account/linkedin-account.module';
import { LinkedInIdeaModule } from './linkedin-idea/linkedin-idea.module';
import { LinkedInPostModule } from './linkedin-post/linkedin-post.module';
import { ProjectAnalyticsModule } from './project-analytics/project-analytics.module';
import { FinanceWeeklyModule } from './finance-weekly/finance-weekly.module';
import { AttentionModule } from './attention/attention.module';
import { DiscordIntegrationModule } from './discord-integration/discord-integration.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    AnthropicModule,
    StorageModule,
    PrismaModule,
    AuditLogModule,
    AuditEventModule,
    PhoneNumbersModule,
    PhoneServicesModule,
    PortfolioModule,
    BackupsModule,
    CredentialsVaultModule,
    CredentialsModule,
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
    ClientModule,
    ClientCallsModule,
    SettingsModule,
    VibeWorkerWebhookModule,
    AnalyticsModule,
    EmployeeModule,
    ProjectModule,
    ProjectReportModule,
    TimeOffModule,
    PayrollModule,
    SalaryReviewModule,
    PaymentSourceModule,
    CompensationAnalyticsModule,
    LinkedInAccountModule,
    LinkedInIdeaModule,
    LinkedInPostModule,
    ProjectAnalyticsModule,
    FinanceWeeklyModule,
    AttentionModule,
    DiscordIntegrationModule,
  ],
})
export class AppModule {}
