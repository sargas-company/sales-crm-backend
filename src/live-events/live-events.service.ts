import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { Subject } from 'rxjs';

import { JOB_POST_QUEUE } from '../job-post/job-post.constants';

export type LiveEvent =
  | { kind: 'webhook.received'; at: string }
  | {
      kind: 'jobpost.changed';
      at: string;
      cause: 'created' | 'processed' | 'failed' | 'skipped' | 'enqueue-decision';
    }
  | { kind: 'queue.state'; at: string }
  | { kind: 'settings.scanner'; at: string; analysisEnabled: boolean }
  | { kind: 'discord.delivered'; at: string; ok: boolean };

/**
 * Fan-out point for live events backing the Overview SSE stream.
 *
 * Two sources feed the same `rxjs.Subject`:
 *   1. direct `emit*` calls from services AFTER a Prisma commit
 *      (`JobPostService.enableAnalysis` → `jobpost.changed`,
 *      `VibeWorker.captureJobPost` → `webhook.received`,
 *      `SettingsService.applySectionUpdate` → `settings.scanner`,
 *      Discord delivery outcome in `NotificationProcessorService`
 *      → `discord.delivered`);
 *   2. BullMQ `QueueEvents` listener on the processing queue —
 *      which under BullMQ 5 is implemented via **Redis Streams**
 *      (not pub/sub), so events survive brief listener gaps and
 *      every backend instance that subscribes sees `completed` /
 *      `failed` / `active` / `waiting` / `stalled` / `delayed` /
 *      `removed` / `paused` / `resumed` for the shared queue. The
 *      web process doesn't need its own worker to hear what the
 *      worker process is doing.
 *
 * Deployment check: today the backend runs the web server and the
 * BullMQ worker inside the SAME Nest process, so direct `emit*`
 * calls from service code reach the SSE pipeline the same way the
 * QueueEvents listener does. If the worker is split into its own
 * process in the future, the DB-level `emit*` calls will still
 * reach that process's SSE subscribers via its own direct writer,
 * but cross-process propagation of `jobpost.changed` / `webhook.received`
 * requires a Redis pub/sub topic — add it here without changing the
 * subscriber surface.
 */
@Injectable()
export class LiveEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveEventsService.name);
  private readonly subject = new Subject<LiveEvent>();
  private connection?: IORedis;
  private queueEvents?: QueueEvents;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    try {
      this.connection = new IORedis({
        host: this.config.get('REDIS_HOST', 'localhost'),
        port: Number(this.config.get('REDIS_PORT', 6379)),
        maxRetriesPerRequest: null,
      });
      const prefix = process.env.BULLMQ_PREFIX || undefined;
      this.queueEvents = new QueueEvents(JOB_POST_QUEUE, {
        connection: this.connection,
        ...(prefix ? { prefix } : {}),
      });
      // Any queue state change triggers a snapshot refresh. We
      // DON'T carry queue details here — the SSE pipeline fetches
      // the current counters per coalesced tick, which is both
      // simpler and avoids payload drift.
      const notify = () => this.subject.next({ kind: 'queue.state', at: new Date().toISOString() });
      this.queueEvents.on('completed', notify);
      this.queueEvents.on('failed', notify);
      this.queueEvents.on('active', notify);
      this.queueEvents.on('waiting', notify);
      this.queueEvents.on('delayed', notify);
      this.queueEvents.on('stalled', notify);
      this.queueEvents.on('removed', notify);
      this.queueEvents.on('paused', notify);
      this.queueEvents.on('resumed', notify);
      this.logger.log(`LiveEventsService: subscribed to QueueEvents("${JOB_POST_QUEUE}")`);
    } catch (err) {
      this.logger.warn(
        `LiveEventsService: QueueEvents init failed, DB events only: ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.queueEvents?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.connection?.quit();
    } catch {
      /* ignore */
    }
  }

  stream$() {
    return this.subject.asObservable();
  }

  emitWebhookReceived(): void {
    this.subject.next({ kind: 'webhook.received', at: new Date().toISOString() });
  }

  emitJobPostChanged(cause: Extract<LiveEvent, { kind: 'jobpost.changed' }>['cause']): void {
    this.subject.next({ kind: 'jobpost.changed', at: new Date().toISOString(), cause });
  }

  emitSettingsScanner(analysisEnabled: boolean): void {
    this.subject.next({
      kind: 'settings.scanner',
      at: new Date().toISOString(),
      analysisEnabled,
    });
  }

  emitDiscordDelivered(ok: boolean): void {
    this.subject.next({ kind: 'discord.delivered', at: new Date().toISOString(), ok });
  }
}
