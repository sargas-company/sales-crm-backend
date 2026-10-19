import { Controller, MessageEvent, Req, Sse, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { plainToInstance } from 'class-transformer';
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
  share,
} from 'rxjs';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { LiveEventsService } from '../live-events/live-events.service';

import { AnalyticsService } from './analytics.service';
import { AiSpendService } from './ai-spend.service';
import { JobPostService } from '../job-post/job-post.service';
import { AnalyticsFiltersDto } from './dto/analytics-filters.dto';

/**
 * Live Overview stream.
 *
 * One authorised SSE endpoint feeds the whole Sales Analytics
 * Overview tab:
 *   • AI pipeline panel (Status / Backlog / Pending / In queue /
 *     Running / Failed) — current operational state, no filter.
 *   • Scanner-health cards (Last hour / Today / Analyzed / Discord
 *     alerts) — "right-now" snapshot, hardcoded to today.
 *   • At-a-glance KPIs (Received / Qualified / Hot / Qualified
 *     rate / Avg score) — scoped to the client's active filter.
 *   • AI spend block (Total / Calls / Avg / tokens + per-day chart +
 *     by-model / by-operation breakdown) — scoped to the client's
 *     active filter.
 *
 * Design:
 *   • Every subscriber gets a **fresh snapshot on connect** — the
 *     stream opens by producing a tick from current DB state, not
 *     from a cached frame. Same on every reconnect.
 *   • Shared trigger — events coalesced into a tick signal, one
 *     RxJS subscription per server regardless of client count. The
 *     snapshot work is done per-client because at-a-glance / ai-spend
 *     depend on the client's own filter.
 *   • `bufferTime(350)` collapses event storms into a single trigger.
 *   • Heartbeat `ping` every 20 s prevents idle reverse-proxy
 *     timeouts and lets the client detect stream death.
 *   • Snapshot composes the existing read paths
 *     (`JobPostService.getQueueStats`, `AnalyticsService.getScannerHealth('today')`,
 *     `AnalyticsService.getSalesOverview(filters)`,
 *     `AiSpendService.getAiSpend(filters)`) so there is no parallel
 *     analytics code to maintain. Each lane is `.catch`-ed so one
 *     failing path doesn't tear the whole stream down.
 *   • When the client changes the central filter the hook on the
 *     frontend reconnects with the new query — a fresh snapshot
 *     arrives immediately for the new window.
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
  // Shared trigger — raw events coalesced to a tick signal (no DB
  // work). Snapshot computation happens per-subscriber in `stream()`
  // because it depends on the client's own filter.
  private readonly tickTrigger$: Observable<void>;

  constructor(
    private readonly events: LiveEventsService,
    private readonly jobPosts: JobPostService,
    private readonly analytics: AnalyticsService,
    private readonly aiSpend: AiSpendService,
  ) {
    this.tickTrigger$ = this.events.stream$().pipe(
      bufferTime(350),
      filter((buf) => buf.length > 0),
      map(() => undefined),
      share(),
    );
  }

  @Sse('stream')
  stream(@Req() req: Request): Observable<MessageEvent> {
    // Filters live in the query string (`dateRange=7d&...`). We
    // parse them manually with class-transformer rather than
    // @Query() because the NestJS @Sse decorator doesn't accept a
    // decorated DTO parameter — see also the AnalyticsFiltersDto
    // used by the sibling REST endpoints for the exact same shape.
    const filters = plainToInstance(
      AnalyticsFiltersDto,
      req.query as Record<string, unknown>,
    );
    // Every subscription (initial connect AND every reconnect)
    // starts with a FRESH snapshot built from current DB state and
    // the client's current filter — reconnecting on a filter change
    // immediately replaces the panels with the new window.
    const buildFrame = () => this.buildSnapshotEvent(filters);
    const initial$ = defer(() => from(buildFrame()));
    const subsequent$ = this.tickTrigger$.pipe(
      concatMap(() => defer(() => from(buildFrame()))),
    );
    const heartbeat$ = interval(20_000).pipe(
      map((): MessageEvent => ({ type: 'ping', data: { at: new Date().toISOString() } })),
    );
    return merge(initial$, subsequent$, heartbeat$);
  }

  private async buildSnapshotEvent(
    filters: AnalyticsFiltersDto,
  ): Promise<MessageEvent> {
    const [queueStats, scanner, salesOverview, aiSpend] = await Promise.all([
      this.jobPosts.getQueueStats().catch((err: unknown) => ({
        error: 'queue-stats-unavailable' as const,
        message: (err as Error).message,
      })),
      this.analytics.getScannerHealth('today').catch((err: unknown) => ({
        error: 'scanner-health-unavailable' as const,
        message: (err as Error).message,
      })),
      this.analytics.getSalesOverview(filters).catch((err: unknown) => ({
        error: 'sales-overview-unavailable' as const,
        message: (err as Error).message,
      })),
      this.aiSpend.getAiSpend(filters).catch((err: unknown) => ({
        error: 'ai-spend-unavailable' as const,
        message: (err as Error).message,
      })),
    ]);
    return {
      type: 'tick',
      data: {
        at: new Date().toISOString(),
        queueStats,
        scanner,
        salesOverview,
        aiSpend,
      },
    };
  }
}
