import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { VibeWorkerWebhookService } from './vibe-worker.service';

const EVENT_ID_HEADER = 'x-vibe-worker-event-id';

const BODY_EVENT_ID_KEYS = ['event_id', 'eventId', 'id'] as const;

@ApiExcludeController()
@Controller('webhooks/vibe-worker')
export class VibeWorkerWebhookController {
  constructor(private readonly service: VibeWorkerWebhookService) {}

  // No auth guard: the real Vibe Worker UI only configures a URL (no
  // custom headers), so the shared-secret header check used to drop
  // every real event. Protection against stray traffic now lives at
  // two layers: Nginx can rate-limit the path, and the
  // `scanner.ingestionEnabled` setting is a hard kill-switch inside
  // `VibeWorkerWebhookService.captureJobPost`. The route is still
  // in `PUBLIC_ALLOWLIST` in authorization-contract.spec.ts.
  @Post('job-post')
  @HttpCode(HttpStatus.ACCEPTED)
  async captureJobPost(
    @Headers(EVENT_ID_HEADER) headerEventId: string | undefined,
    @Body() payload: unknown,
  ): Promise<{ accepted: true; eventId: string; duplicate: boolean }> {
    const providedEventId =
      normaliseId(headerEventId) ?? extractBodyEventId(payload);

    const { eventId, duplicate } = await this.service.captureJobPost(
      payload,
      providedEventId,
    );

    return { accepted: true, eventId, duplicate };
  }
}

function normaliseId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractBodyEventId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  for (const key of BODY_EVENT_ID_KEYS) {
    const value = normaliseId(obj[key]);
    if (value) return value;
  }
  return null;
}
