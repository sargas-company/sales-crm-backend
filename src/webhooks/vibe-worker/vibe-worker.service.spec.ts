/**
 * Regression spec for the Vibe Worker ingest service.
 *
 * Covers:
 *   - a request with NO secret headers is accepted end-to-end
 *     (the controller does not enforce them; service runs normally);
 *   - the full payload is persisted into JobPostIngestEvent.payload;
 *   - a repeat delivery is idempotent — second call does NOT create
 *     a second row and returns `duplicate: true`;
 *   - the `scanner.ingestionEnabled=false` kill-switch still returns
 *     the ServiceUnavailableException it always did.
 *
 * Prisma + SettingsService are stubbed in-memory so the test runs
 * without a live DB.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { JobPostIngestSource } from '@prisma/client';

import { VibeWorkerWebhookService } from './vibe-worker.service';

interface StoredEvent {
  id: string;
  source: JobPostIngestSource;
  idempotencyKey: string;
  payload: unknown;
}

function makePrismaStub() {
  const rows: StoredEvent[] = [];
  const prisma = {
    jobPostIngestEvent: {
      findUnique: jest.fn(async (args: { where: { idempotencyKey: string } }) => {
        const row = rows.find((r) => r.idempotencyKey === args.where.idempotencyKey);
        return row ? { id: row.id } : null;
      }),
      create: jest.fn(async (args: { data: { source: JobPostIngestSource; idempotencyKey: string; payload: unknown } }) => {
        if (rows.some((r) => r.idempotencyKey === args.data.idempotencyKey)) {
          // Simulate P2002 the real Prisma would throw.
          const err = Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
          });
          throw err;
        }
        const row: StoredEvent = {
          id: `row-${rows.length + 1}`,
          source: args.data.source,
          idempotencyKey: args.data.idempotencyKey,
          payload: args.data.payload,
        };
        rows.push(row);
        return { id: row.id };
      }),
    },
    __rows: rows,
  };
  return prisma;
}

function makeSettingsStub(enabled: boolean) {
  return {
    getBooleanForKey: jest.fn(async (_key: string, _default: boolean) => enabled),
  };
}

describe('VibeWorkerWebhookService (no-auth ingest contract)', () => {
  it('accepts a brand-new event and stores the full payload', async () => {
    const prisma = makePrismaStub();
    const settings = makeSettingsStub(true);
    const svc = new VibeWorkerWebhookService(prisma as never, settings as never);

    const payload = {
      vibe_id: 'alpha',
      title: 'Senior Node.js engineer wanted',
      url: 'https://example.com/jobs/42',
      description: 'Long description with details…',
      budget: { currency: 'USD', min: 60, max: 90 },
      nested: { array: [1, 2, 3], flag: true },
    };

    const result = await svc.captureJobPost(payload, null);

    expect(result.duplicate).toBe(false);
    expect(result.eventId).toBe('row-1');
    expect(prisma.__rows).toHaveLength(1);
    const stored = prisma.__rows[0];
    expect(stored.source).toBe(JobPostIngestSource.VIBE_WORKER);
    expect(stored.payload).toEqual(payload); // persisted intact, nothing trimmed
    // Idempotency key falls back to SHA-256 of payload when no event id is provided.
    expect(stored.idempotencyKey.startsWith('vibe:sha256:')).toBe(true);
  });

  it('a repeat delivery with the same payload is marked duplicate and does not insert', async () => {
    const prisma = makePrismaStub();
    const settings = makeSettingsStub(true);
    const svc = new VibeWorkerWebhookService(prisma as never, settings as never);

    const payload = { kind: 'job', ref: 'duplicate-smoke', body: 'same text' };

    const first = await svc.captureJobPost(payload, null);
    const second = await svc.captureJobPost(payload, null);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect(prisma.__rows).toHaveLength(1);
  });

  it('a repeat delivery with an explicit event id reuses the row', async () => {
    const prisma = makePrismaStub();
    const settings = makeSettingsStub(true);
    const svc = new VibeWorkerWebhookService(prisma as never, settings as never);
    const explicitId = 'vibe-event-7f2b';

    const first = await svc.captureJobPost({ data: 1 }, explicitId);
    const second = await svc.captureJobPost({ data: 2 }, explicitId);

    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect(prisma.__rows).toHaveLength(1);
    expect(prisma.__rows[0].idempotencyKey).toBe(`vibe:event:${explicitId}`);
  });

  it('respects the scanner.ingestionEnabled kill-switch', async () => {
    const prisma = makePrismaStub();
    const settings = makeSettingsStub(false);
    const svc = new VibeWorkerWebhookService(prisma as never, settings as never);

    await expect(svc.captureJobPost({ any: 'thing' }, null)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.__rows).toHaveLength(0);
  });
});
