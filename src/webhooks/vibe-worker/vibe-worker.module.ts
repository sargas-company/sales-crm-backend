import { Module } from '@nestjs/common';

import { SettingsModule } from '../../settings/settings.module';
import { VibeWorkerWebhookController } from './vibe-worker.controller';
import { VibeWorkerWebhookService } from './vibe-worker.service';

// POST /webhooks/vibe-worker/job-post is public: the real Vibe Worker
// UI cannot attach custom headers, so the previous shared-secret
// guard would drop every real event. The endpoint stays in
// PUBLIC_ALLOWLIST (authorization-contract.spec.ts), and the only
// gate is the `scanner.ingestionEnabled` kill-switch inside
// VibeWorkerWebhookService.
@Module({
  imports: [SettingsModule],
  controllers: [VibeWorkerWebhookController],
  providers: [VibeWorkerWebhookService],
})
export class VibeWorkerWebhookModule {}
