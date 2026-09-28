import { Module } from '@nestjs/common';

import { VibeWorkerWebhookController } from './vibe-worker.controller';
import { VibeWorkerWebhookGuard } from './vibe-worker.guard';
import { VibeWorkerWebhookService } from './vibe-worker.service';

@Module({
  controllers: [VibeWorkerWebhookController],
  providers: [VibeWorkerWebhookGuard, VibeWorkerWebhookService],
})
export class VibeWorkerWebhookModule {}
