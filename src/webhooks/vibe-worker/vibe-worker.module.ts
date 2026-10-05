import { Module } from '@nestjs/common';

import { SettingsModule } from '../../settings/settings.module';
import { VibeWorkerWebhookController } from './vibe-worker.controller';
import { VibeWorkerWebhookGuard } from './vibe-worker.guard';
import { VibeWorkerWebhookService } from './vibe-worker.service';

@Module({
  imports: [SettingsModule],
  controllers: [VibeWorkerWebhookController],
  providers: [VibeWorkerWebhookGuard, VibeWorkerWebhookService],
})
export class VibeWorkerWebhookModule {}
