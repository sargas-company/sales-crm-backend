import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AccountModule } from './account/account.module';
import { ClientCallsModule } from './client-calls/client-calls.module';
import { AuthModule } from './auth/auth.module';
import { ClientRequestsModule } from './client-requests/client-requests.module';
import { CounterpartyModule } from './counterparty/counterparty.module';
import { InvoiceModule } from './invoice/invoice.module';
import { SettingsModule } from './settings/settings.module';
import { PlatformModule } from './platform/platform.module';
import { BaseKnowledgeModule } from './base-knowledge/base-knowledge.module';
import { ChatModule } from './chat/chat.module';
import { JobPostModule } from './job-post/job-post.module';
import { LeadModule } from './lead/lead.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProposalModule } from './proposal/proposal.module';
import { PromptModule } from './prompt/prompt.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    PlatformModule,
    AccountModule,
    ProposalModule,
    BaseKnowledgeModule,
    ChatModule,
    PromptModule,
    LeadModule,
    JobPostModule,
    TelegramModule,
    ClientRequestsModule,
    InvoiceModule,
    CounterpartyModule,
    ClientCallsModule,
    SettingsModule,
  ],
})
export class AppModule {}
