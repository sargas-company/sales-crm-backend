import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { VibeWorkerWebhookGuard } from './vibe-worker.guard';
import { VibeWorkerWebhookService } from './vibe-worker.service';

const EVENT_ID_HEADER = 'x-vibe-worker-event-id';

const BODY_EVENT_ID_KEYS = ['event_id', 'eventId', 'id'] as const;

@ApiExcludeController()
@Controller('webhooks/vibe-worker')
export class VibeWorkerWebhookController {
  constructor(private readonly service: VibeWorkerWebhookService) {}

  @Post('job-post')
  @UseGuards(VibeWorkerWebhookGuard)
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
