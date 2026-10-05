import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { DiscordInteractionsController } from './discord-interactions.controller';
import { DiscordReportService } from './discord-report.service';
import { DiscordProfilesController } from './discord-profiles.controller';
import { DiscordProfilesService } from './discord-profiles.service';
import { DiscordBotClient } from './discord-bot.client';
import { DiscordSchedulersService } from './discord-schedulers.service';
import { DiscordEmbedBuilderService } from './discord-embed-builder.service';
import { DiscordLateReportService } from './discord-late-report.service';
import { DiscordAdminService } from './discord-admin.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [DiscordInteractionsController, DiscordProfilesController],
  providers: [
    DiscordReportService,
    DiscordProfilesService,
    DiscordBotClient,
    DiscordEmbedBuilderService,
    DiscordLateReportService,
    DiscordSchedulersService,
    DiscordAdminService,
  ],
  exports: [
    DiscordReportService,
    DiscordProfilesService,
    DiscordBotClient,
    DiscordEmbedBuilderService,
    DiscordLateReportService,
    DiscordAdminService,
  ],
})
export class DiscordIntegrationModule {}
