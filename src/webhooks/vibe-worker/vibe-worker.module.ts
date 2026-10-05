import { Module } from '@nestjs/common';

import { JobPostModule } from '../../job-post/job-post.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { SettingsModule } from '../../settings/settings.module';
import { VibeIngestProcessorService } from './vibe-ingest-processor.service';
import { VibeIngestScheduler } from './vibe-ingest.scheduler';
import { VibeWorkerWebhookController } from './vibe-worker.controller';
import { VibeWorkerWebhookService } from './vibe-worker.service';

// POST /webhooks/vibe-worker/job-post is public: the real Vibe Worker
// UI cannot attach custom headers, so the previous shared-secret
// guard would drop every real event. The endpoint stays in
// PUBLIC_ALLOWLIST (authorization-contract.spec.ts), and the only
// gate is the `scanner.ingestionEnabled` kill-switch inside
// VibeWorkerWebhookService.
//
// Durability: the controller only persists the ingest event and
// returns 202. VibeIngestScheduler drains RECEIVED events and
// reconciles NEW JobPost rows on a cron tick (both guarded by a
// Postgres advisory lock), so a transient Redis outage or a
// scanner.analysisEnabled false→true flip recovers without a
// backend restart. OnModuleInit recovery stays as a startup safety
// net.
@Module({
  imports: [PrismaModule, SettingsModule, JobPostModule],
  controllers: [VibeWorkerWebhookController],
  providers: [
    VibeWorkerWebhookService,
    VibeIngestProcessorService,
    VibeIngestScheduler,
  ],
  exports: [VibeIngestProcessorService],
})
export class VibeWorkerWebhookModule {}
