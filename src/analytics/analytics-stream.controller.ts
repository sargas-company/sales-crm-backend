import { Controller, MessageEvent, Sse, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import {
  bufferTime,
  concatMap,
  defer,
  filter,
  from,
  interval,
  map,
  merge,
  Observable,
  shareReplay,
} from 'rxjs';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { LiveEventsService } from '../live-events/live-events.service';

import { AnalyticsService } from './analytics.service';
import { JobPostService } from '../job-post/job-post.service';

/**
 * Live Overview stream.
 *
 * One authorised SSE endpoint feeds both the AI pipeline panel
 * (Status / Backlog / Pending / In queue / Running / Failed) and
 * the four scanner-health cards (Last hour / Today / Analyzed /
 * Discord alerts) rendered on the Sales Analytics Overview tab.
 *
 * Design:
 *   • Every subscriber gets a **fresh snapshot on connect** — the
 *     stream opens by producing a tick from current DB state, not
 *     from a cached frame. Same on every reconnect (new HTTP
 *     response → new subscription → new initial snapshot). This
 *     holds even on a quiet system with no live events.
 *   • Shared coalesced pipeline for subsequent updates — one DB
 *     round-trip per coalesce window regardless of client count.
 *   • `bufferTime(350)` collapses event storms into a single frame.
 *   • Heartbeat `ping` every 20s prevents idle reverse-proxy
 *     timeouts and lets the client detect stream death.
 *   • Snapshot composes the existing read paths
 *     (`JobPostService.getQueueStats()` +
 *     `AnalyticsService.getScannerHealth('today')`) so there is no
 *     parallel analytics code to maintain.
 *   • `getScannerHealth` / `getQueueStats` throws when their data
 *     layer is unreachable; the pipeline catches each independently
 *     so one failing path doesn't tear the whole stream down.
 *   • Permission is `sales_analytics:view` — operators who can see
 *     the dashboard can see live updates; management of the scanner
 *     (pause/resume) stays behind `settings_scanner:update` on the
 *     write endpoint.
 */
@ApiExcludeController()
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission('sales_analytics:view')
@Controller('analytics')
export class AnalyticsStreamController {
  // Shared across subscribers so an event storm costs one DB
  // round-trip across N clients, not N × storm-size.
  private readonly shared$: Observable<MessageEvent>;

  constructor(
    private readonly events: LiveEventsService,
    private readonly jobPosts: JobPostService,
    private readonly analytics: AnalyticsService,
  ) {
    const coalescedTicks$ = this.events.stream$().pipe(
      bufferTime(350),
      filter((buf) => buf.length > 0),
      concatMap(() => defer(() => from(this.buildSnapshotEvent()))),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    const heartbeat$ = interval(20_000).pipe(
      map((): MessageEvent => ({ type: 'ping', data: { at: new Date().toISOString() } })),
    );

    this.shared$ = merge(coalescedTicks$, heartbeat$);
  }

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    // Every subscription (initial connect AND every reconnect)
    // starts with a FRESH snapshot built from current DB state —
    // we deliberately do NOT reuse the shareReplay'd cache for the
    // first frame, so a reconnecting client never sees a stale tick
    // from before the disconnect.
    const initial$ = defer(() => from(this.buildSnapshotEvent()));
    return merge(initial$, this.shared$);
  }

  private async buildSnapshotEvent(): Promise<MessageEvent> {
    const [queueStats, scanner] = await Promise.all([
      this.jobPosts.getQueueStats().catch((err: unknown) => {
        return {
          error: 'queue-stats-unavailable' as const,
          message: (err as Error).message,
        };
      }),
      this.analytics
        .getScannerHealth('today')
        .catch((err: unknown) => ({
          error: 'scanner-health-unavailable' as const,
          message: (err as Error).message,
        })),
    ]);
    return {
      type: 'tick',
      data: {
        at: new Date().toISOString(),
        queueStats,
        scanner,
      },
    };
  }
}
