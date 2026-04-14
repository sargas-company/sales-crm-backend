import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module';
import { BaseKnowledgeModule } from './base-knowledge/base-knowledge.module';
import { ChatModule } from './chat/chat.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProposalModule } from './proposal/proposal.module';
import { SettingsModule } from './settings/settings.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    ProposalModule,
    BaseKnowledgeModule,
    ChatModule,
    SettingsModule,
  ],
})
export class AppModule {}
