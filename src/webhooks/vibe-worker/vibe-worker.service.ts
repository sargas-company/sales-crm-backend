import { Injectable, Logger } from '@nestjs/common';
import {
  JobPostIngestEvent,
  JobPostIngestSource,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';

import { PrismaService } from '../../prisma/prisma.service';

export interface CapturedEventResult {
  eventId: string;
  duplicate: boolean;
}

@Injectable()
export class VibeWorkerWebhookService {
  private readonly logger = new Logger(VibeWorkerWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async captureJobPost(
    payload: unknown,
    providedEventId: string | null,
  ): Promise<CapturedEventResult> {
    const idempotencyKey = providedEventId
      ? `vibe:event:${providedEventId}`
      : `vibe:sha256:${stableHash(payload)}`;

    const stored = payload as Prisma.InputJsonValue;

    const existing = await this.prisma.jobPostIngestEvent.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });

    if (existing) {
      this.logger.log(
        `Vibe Worker webhook: duplicate event (idempotencyKey source=${
          providedEventId ? 'header/body' : 'sha256'
        })`,
      );
      return { eventId: existing.id, duplicate: true };
    }

    try {
      const created = await this.prisma.jobPostIngestEvent.create({
        data: {
          source: JobPostIngestSource.VIBE_WORKER,
          idempotencyKey,
          payload: stored,
        },
        select: { id: true },
      });
      this.logger.log(
        `Vibe Worker webhook: captured event ${created.id} (idempotencyKey source=${
          providedEventId ? 'header/body' : 'sha256'
        })`,
      );
      return { eventId: created.id, duplicate: false };
    } catch (err) {
      // Race with a concurrent duplicate delivery. The unique index on
      // idempotencyKey serialises us; re-read and return the winner.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.prisma.jobPostIngestEvent.findUnique({
          where: { idempotencyKey },
          select: { id: true },
        });
        if (winner) {
          return { eventId: winner.id, duplicate: true };
        }
      }
      throw err;
    }
  }

  async findLatest(limit = 1): Promise<Pick<JobPostIngestEvent, 'id' | 'receivedAt'>[]> {
    return this.prisma.jobPostIngestEvent.findMany({
      orderBy: { receivedAt: 'desc' },
      take: limit,
      select: { id: true, receivedAt: true },
    });
  }
}

/**
 * Deterministic SHA-256 hash of a JSON-serialisable value. Object keys are
 * sorted recursively so `{a:1,b:2}` and `{b:2,a:1}` produce the same hash.
 * Arrays keep their order (order is meaningful).
 */
function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
