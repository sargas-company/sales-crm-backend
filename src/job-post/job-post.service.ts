import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { Prisma, ProposalSource, ProposalType } from '@prisma/client';

import { JobPostQueueService } from './job-post-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import { LiveEventsService } from '../live-events/live-events.service';
import { AiJobEvaluatorService } from './ai-job-evaluator.service';
import { ConvertToProposalDto } from './dto/convert-to-proposal.dto';
import {
  EnableAnalysisDto,
  EnableAnalysisStrategy,
} from './dto/enable-analysis.dto';
import { PreviewEnableAnalysisDto } from './dto/preview-enable-analysis.dto';
import { JobPostStatsDto } from './dto/job-post-stats.dto';

/* ─── AI cost model constants ─────────────────────────────────────
 *
 * Rates (per 1M tokens) from Anthropic's public Claude 5.5 tariff —
 * https://platform.claude.com/docs/en/about-claude/pricing — at
 * ≤100 k-token inputs. Cache-write-1h is 2× regular input; cache-read
 * is 0.1× regular input. Both cache rates are shown as separate
 * fields in the preview so the UI can say what it is NOT promising
 * (cache savings require real hits).
 *
 * Avg-token fallbacks are a conservative upper bound. When
 * PROCESSED usage history for the CURRENT configured model is
 * available we average the last N rows and label the preview
 * `usedUsageHistory=true`; usage from a different (older) model is
 * ignored for this purpose. */
const PRICING = {
  haiku: {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheWrite1hPerMTok: 0.2,
    cacheReadPerMTok: 0.01,
  },
  sonnet: {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheWrite1hPerMTok: 4,
    cacheReadPerMTok: 0.1,
  },
} as const;

/**
 * Minimum cacheable prefix for either Claude 5.5 model, in tokens.
 * Prompts shorter than this silently drop the cache_control marker.
 * The real "cache is working" signal is `cache_read_input_tokens`
 * in the usage block — the marker itself proves nothing.
 */
export const CACHE_MIN_PREFIX_TOKENS = 512;

const AVG_TOKENS_FALLBACK = {
  haiku: { input: 3200, output: 200 },
  sonnet: { input: 4800, output: 650 },
} as const;

const SONNET_PASSTHROUGH_LOW = 0.10;
const SONNET_PASSTHROUGH_HIGH = 0.20;

function costPerPost(
  stage: 'haiku' | 'sonnet',
  avgTokens: { input: number; output: number } = AVG_TOKENS_FALLBACK[stage],
): number {
  const p = PRICING[stage];
  return (avgTokens.input * p.inputPerMTok + avgTokens.output * p.outputPerMTok) / 1_000_000;
}
import {
  JobPostSortBy,
  JobPostSortDirection,
  ListJobPostsDto,
} from './dto/list-job-posts.dto';

const JOB_POST_SELECT = {
  id: true,
  chatId: true,
  messageId: true,
  status: true,
  enqueueState: true,
  decision: true,
  matchScore: true,
  priority: true,
  createdAt: true,
  processedAt: true,
  title: true,
  jobUrl: true,
  scanner: true,
  location: true,
  budget: true,
  totalSpent: true,
  avgRatePaid: true,
  hireRate: true,
  hSkillsKeywords: true,
  // Phase A — normalised fields the new list cells read.
  budgetType: true,
  budgetMin: true,
  budgetMax: true,
  budgetCurrency: true,
  postedAt: true,
  country: true,
  city: true,
  clientPaymentVerified: true,
  clientRating: true,
  clientHires: true,
  // Gatekeeper + evaluation blob — surfaced on the list so the UI
  // can render per-row `Verdict GK` (fit + confidence) and the
  // `Score · Verdict EV` column can show `—` when the row never
  // reached Sonnet. The blob is ~1-2 KB per row; cheap enough on
  // the list vs. computing a slim derived shape.
  aiResponse: true,
  proposal: { select: { id: true } },
} satisfies Prisma.JobPostSelect;

const withViewSelect = (userId: string) =>
  ({
    ...JOB_POST_SELECT,
    views: {
      where: { userId },
      select: { viewedAt: true },
      take: 1,
    },
  }) satisfies Prisma.JobPostSelect;

/** Shape returned to the API: flatten `views[0].viewedAt` into a top-level
 * nullable string so callers see one record per post, same shape as before
 * with one extra field. */
type JobPostRow = Prisma.JobPostGetPayload<{
  select: ReturnType<typeof withViewSelect>;
}>;

const flattenViewedAt = <R extends JobPostRow>({
  views,
  ...rest
}: R): Omit<R, 'views'> & { viewedAt: string | null } => ({
  ...rest,
  viewedAt: views?.[0]?.viewedAt?.toISOString() ?? null,
});

@Injectable()
export class JobPostService {
  private readonly logger = new Logger(JobPostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly queue: JobPostQueueService,
    private readonly liveEvents: LiveEventsService,
    private readonly evaluator: AiJobEvaluatorService,
  ) {}

  async findAll(dto: ListJobPostsDto, userId: string) {
    const {
      decision,
      priority,
      minScore,
      maxScore,
      sortBy,
      sortDirection = JobPostSortDirection.desc,
      search,
      status,
      limit = 20,
      offset = 0,
      createdFrom,
      createdTo,
      viewed,
      country,
    } = dto;

    // Score filter honours only the user-explicit min/max. We do
    // NOT exclude NULL-score rows just because the user sorted by
    // matchScore — the orderBy pins NULLs to the tail
    // (`nulls: 'last'`), so NULL rows stay visible and the
    // Prev/Next neighbor walk steps through them in the same
    // order.
    const matchScoreFilter: Prisma.IntNullableFilter = {
      ...(minScore !== undefined ? { gte: minScore } : {}),
      ...(maxScore !== undefined ? { lte: maxScore } : {}),
    };

    // Per-user view filter. `views` is a 1:many table keyed by
    // (jobPostId, userId); a row's presence means the user opened
    // the post. `viewed=viewed` → `some { userId }`; `unviewed` →
    // `none { userId }`. Omitting the filter returns both.
    const viewFilter: Prisma.JobPostWhereInput =
      viewed === 'viewed'
        ? { views: { some: { userId } } }
        : viewed === 'unviewed'
          ? { views: { none: { userId } } }
          : {};

    // Country filter — substring match (case-insensitive) on the
    // normalised `country` field OR the legacy raw `location`
    // string, so posts ingested before the Phase A split are
    // still searchable.
    const countryFilter: Prisma.JobPostWhereInput = country
      ? {
          OR: [
            { country: { contains: country, mode: 'insensitive' } },
            { location: { contains: country, mode: 'insensitive' } },
          ],
        }
      : {};

    const where: Prisma.JobPostWhereInput = {
      ...(status ? { status } : {}),
      ...(decision && { decision }),
      ...(priority && { priority }),
      ...(Object.keys(matchScoreFilter).length
        ? { matchScore: matchScoreFilter }
        : {}),
      ...(search
        ? { title: { contains: search, mode: 'insensitive' } }
        : {}),
      ...(createdFrom || createdTo
        ? {
            createdAt: {
              ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
              ...(createdTo ? { lte: new Date(createdTo) } : {}),
            },
          }
        : {}),
      ...viewFilter,
      ...countryFilter,
    };

    const orderBy = this.buildOrderBy(sortBy, sortDirection);

    const [data, total] = await Promise.all([
      this.prisma.jobPost.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        select: withViewSelect(userId),
      }),
      this.prisma.jobPost.count({ where }),
    ]);

    this.logger.log(`findAll: returned ${data.length} of ${total}`);

    return { data: data.map(flattenViewedAt), meta: { total, limit, offset } };
  }

  /**
   * Stable list order:
   *   • user-chosen sortBy + direction;
   *   • NULLs always pinned to the end (`nulls: 'last'`), so a
   *     NULL-containing row is never dropped from the list and
   *     Prev/Next can still walk through it;
   *   • `id ASC` as the tiebreaker, so equal sort-column values
   *     have a deterministic total order and the keyset neighbor
   *     walk matches the visible list exactly.
   *
   * `createdAt` / `status` are not nullable at the schema level,
   * but we still emit the explicit `{sort, nulls}` form for
   * symmetry — Postgres happily accepts it and the list ordering
   * stays obviously consistent across columns.
   */
  private buildOrderBy(
    sortBy: JobPostSortBy | undefined,
    sortDirection: JobPostSortDirection,
  ): Prisma.JobPostOrderByWithRelationInput[] {
    const dir: Prisma.SortOrder = sortDirection;
    const effective = sortBy ?? JobPostSortBy.createdAt;
    // Non-nullable sort columns on JobPost — Prisma rejects
    // `nulls: 'last'` on these at validation time.
    const nonNullable: ReadonlySet<JobPostSortBy> = new Set([
      JobPostSortBy.createdAt,
      JobPostSortBy.status,
    ]);
    const primary: Prisma.JobPostOrderByWithRelationInput = nonNullable.has(
      effective,
    )
      ? ({ [effective]: dir } as Prisma.JobPostOrderByWithRelationInput)
      : ({
          [effective]: { sort: dir, nulls: 'last' },
        } as Prisma.JobPostOrderByWithRelationInput);
    return [primary, { id: 'asc' }];
  }

  async getStats(dto: JobPostStatsDto) {
    const dateFilter: Prisma.DateTimeFilter = {
      ...(dto.from ? { gte: new Date(dto.from) } : {}),
      ...(dto.to ? { lte: new Date(dto.to) } : {}),
    };
    const hasDates = dto.from || dto.to;
    const baseWhere: Prisma.JobPostWhereInput = hasDates
      ? { createdAt: dateFilter }
      : {};
    const processedWhere: Prisma.JobPostWhereInput = {
      ...baseWhere,
      status: 'PROCESSED',
    };

    const [byStatus, byDecision, byPriority, scoreAgg, ranges, medianResult] =
      await Promise.all([
        this.prisma.jobPost.groupBy({
          by: ['status'],
          where: baseWhere,
          _count: true,
        }),
        this.prisma.jobPost.groupBy({
          by: ['decision'],
          where: { ...processedWhere, decision: { not: null } },
          _count: true,
        }),
        this.prisma.jobPost.groupBy({
          by: ['priority'],
          where: { ...processedWhere, priority: { not: null } },
          _count: true,
        }),
        this.prisma.jobPost.aggregate({
          where: { ...processedWhere, matchScore: { not: null } },
          _avg: { matchScore: true },
          _min: { matchScore: true },
          _max: { matchScore: true },
        }),
        Promise.all([
          // v2 decision thresholds: approve high ≥ 90; approve
          // medium 71-89; maybe medium 50-70; maybe low 40-49;
          // decline 0-39.
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 90 } },
          }),
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 71, lt: 90 } },
          }),
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 50, lt: 71 } },
          }),
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 40, lt: 50 } },
          }),
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 0, lt: 40 } },
          }),
        ]),
        this.prisma.$queryRaw<[{ median: number }]>`
          SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "matchScore")::int AS median
          FROM "JobPost"
          WHERE status = 'PROCESSED'
            AND "matchScore" IS NOT NULL
            ${hasDates && dto.from ? Prisma.sql`AND "createdAt" >= ${new Date(dto.from)}` : Prisma.empty}
            ${hasDates && dto.to ? Prisma.sql`AND "createdAt" <= ${new Date(dto.to)}` : Prisma.empty}
        `,
      ]);

    const toMap = <T extends string>(
      rows: { _count: number; [k: string]: unknown }[],
      key: string,
    ): Record<string, number> =>
      Object.fromEntries(rows.map((r) => [r[key] as T, r._count]));

    return {
      period: { from: dto.from ?? null, to: dto.to ?? null },
      total: byStatus.reduce((s, r) => s + r._count, 0),
      byStatus: toMap(byStatus, 'status'),
      decisions: toMap(byDecision, 'decision'),
      priority: toMap(byPriority, 'priority'),
      score: {
        avg:
          scoreAgg._avg.matchScore !== null
            ? Math.round(scoreAgg._avg.matchScore)
            : null,
        median: medianResult[0]?.median ?? null,
        min: scoreAgg._min.matchScore,
        max: scoreAgg._max.matchScore,
      },
      scoreRanges: {
        '85_100': ranges[0],
        '70_84': ranges[1],
        '55_69': ranges[2],
        '40_54': ranges[3],
        '0_39': ranges[4],
      },
    };
  }

  /**
   * Keyset neighbor lookup for the detail page's Prev / Next.
   * Walks the EXACT same total order the list uses:
   *   (sortCol <sortDir> NULLS LAST, id ASC).
   * No NULL exclusion, no `createdAt` fallback — if the current
   * post has NULL on the sort column it is in the "null tail"
   * of the list and Prev/Next step through that tail by `id`.
   *
   * Keyset breakdown (list order is `col <dir> NULLS LAST,
   * id ASC`; `nextOp` = `<` for desc, `>` for asc):
   *
   *   NEXT (walk forward):
   *     current is NOT NULL:
   *       col <nextOp> cur.col  (non-null section continues)
   *       OR (col = cur.col AND id > cur.id)  (same val, bigger id)
   *       OR col IS NULL  (null tail is "after" any non-null)
   *     current IS NULL:
   *       col IS NULL AND id > cur.id  (within null tail)
   *
   *   PREV (walk backward):
   *     current is NOT NULL:
   *       col <prevOp> cur.col  (non-null section, strictly larger if desc)
   *       OR (col = cur.col AND id < cur.id)
   *     current IS NULL:
   *       col IS NOT NULL  (every non-null is "before" the null tail)
   *       OR (col IS NULL AND id < cur.id)
   *
   * Row at `id` is excluded via `id: { not: id }` so a user who
   * just viewed the current post cannot be bounced back to it.
   */
  async findNeighbor(
    id: string,
    userId: string,
    direction: 'prev' | 'next',
    dto: ListJobPostsDto,
  ): Promise<{ id: string | null }> {
    const sortBy = (dto.sortBy as JobPostSortBy) ?? JobPostSortBy.createdAt;
    const sortDir = dto.sortDirection ?? JobPostSortDirection.desc;

    const current = await this.prisma.jobPost.findUnique({
      where: { id },
      select: { [sortBy]: true } as Prisma.JobPostSelect,
    });
    if (!current) throw new NotFoundException(`JobPost ${id} not found`);

    const curVal = (current as unknown as Record<string, unknown>)[sortBy];
    const curIsNull = curVal === null || curVal === undefined;

    const {
      decision,
      priority,
      minScore,
      maxScore,
      search,
      status,
      createdFrom,
      createdTo,
      viewed,
    } = dto;

    // Score filter honours only user-explicit min/max; never
    // forces `not: null` on the basis of sortBy. See `findAll`
    // for the symmetric policy.
    const scoreFilterActive = minScore !== undefined || maxScore !== undefined;
    const matchScoreFilter: Prisma.IntNullableFilter = {
      ...(minScore !== undefined ? { gte: minScore } : {}),
      ...(maxScore !== undefined ? { lte: maxScore } : {}),
    };

    const viewFilter: Prisma.JobPostWhereInput =
      viewed === 'viewed'
        ? { views: { some: { userId } } }
        : viewed === 'unviewed'
          ? { views: { none: { userId } } }
          : {};

    const baseWhere: Prisma.JobPostWhereInput = {
      ...(status ? { status } : {}),
      ...(decision && { decision }),
      ...(priority && { priority }),
      ...(scoreFilterActive && Object.keys(matchScoreFilter).length
        ? { matchScore: matchScoreFilter }
        : {}),
      ...(search
        ? { title: { contains: search, mode: 'insensitive' } }
        : {}),
      ...(createdFrom || createdTo
        ? {
            createdAt: {
              ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
              ...(createdTo ? { lte: new Date(createdTo) } : {}),
            },
          }
        : {}),
      ...viewFilter,
      id: { not: id },
    };

    const listSortDesc = sortDir === JobPostSortDirection.desc;
    // Non-nullable columns on JobPost that can be sorted on. For
    // these the `{col: null}` and `nulls: 'first/last'` branches
    // are unreachable (and Prisma rejects them at validation
    // time), so we drop them from the keyset.
    const SORT_COL_NON_NULLABLE: ReadonlySet<JobPostSortBy> = new Set([
      JobPostSortBy.createdAt,
      JobPostSortBy.status,
    ]);
    const sortColNullable = !SORT_COL_NON_NULLABLE.has(sortBy);

    let cursorWhere: Prisma.JobPostWhereInput;
    let orderBy: Prisma.JobPostOrderByWithRelationInput[];

    if (direction === 'next') {
      const colOp: 'lt' | 'gt' = listSortDesc ? 'lt' : 'gt';
      if (!curIsNull) {
        const orBranches: Prisma.JobPostWhereInput[] = [
          { [sortBy]: { [colOp]: curVal } } as Prisma.JobPostWhereInput,
          {
            AND: [
              { [sortBy]: curVal } as Prisma.JobPostWhereInput,
              { id: { gt: id } } as Prisma.JobPostWhereInput,
            ],
          },
        ];
        if (sortColNullable) {
          orBranches.push({ [sortBy]: null } as Prisma.JobPostWhereInput);
        }
        cursorWhere = { OR: orBranches };
      } else {
        cursorWhere = {
          AND: [
            { [sortBy]: null } as Prisma.JobPostWhereInput,
            { id: { gt: id } } as Prisma.JobPostWhereInput,
          ],
        };
      }
      const primary = sortColNullable
        ? ({
            [sortBy]: { sort: listSortDesc ? 'desc' : 'asc', nulls: 'last' },
          } as Prisma.JobPostOrderByWithRelationInput)
        : ({
            [sortBy]: listSortDesc ? 'desc' : 'asc',
          } as Prisma.JobPostOrderByWithRelationInput);
      orderBy = [primary, { id: 'asc' }];
    } else {
      const prevColOp: 'lt' | 'gt' = listSortDesc ? 'gt' : 'lt';
      if (!curIsNull) {
        cursorWhere = {
          OR: [
            { [sortBy]: { [prevColOp]: curVal } } as Prisma.JobPostWhereInput,
            {
              AND: [
                { [sortBy]: curVal } as Prisma.JobPostWhereInput,
                { id: { lt: id } } as Prisma.JobPostWhereInput,
              ],
            },
          ],
        };
      } else {
        cursorWhere = {
          OR: [
            { [sortBy]: { not: null } } as Prisma.JobPostWhereInput,
            {
              AND: [
                { [sortBy]: null } as Prisma.JobPostWhereInput,
                { id: { lt: id } } as Prisma.JobPostWhereInput,
              ],
            },
          ],
        };
      }
      const primary = sortColNullable
        ? ({
            [sortBy]: { sort: listSortDesc ? 'asc' : 'desc', nulls: 'first' },
          } as Prisma.JobPostOrderByWithRelationInput)
        : ({
            [sortBy]: listSortDesc ? 'asc' : 'desc',
          } as Prisma.JobPostOrderByWithRelationInput);
      orderBy = [primary, { id: 'desc' }];
    }

    const row = await this.prisma.jobPost.findFirst({
      where: { AND: [baseWhere, cursorWhere] },
      orderBy,
      select: { id: true },
    });
    return { id: row?.id ?? null };
  }

  async findOne(id: string, userId: string) {
    const jobPost = await this.prisma.jobPost.findUnique({
      where: { id },
      include: {
        proposal: { select: { id: true } },
        views: {
          where: { userId },
          select: { viewedAt: true },
          take: 1,
        },
      },
    });

    if (!jobPost) throw new NotFoundException(`JobPost ${id} not found`);

    const { views, ...rest } = jobPost;
    return {
      ...rest,
      viewedAt: views?.[0]?.viewedAt?.toISOString() ?? null,
    };
  }

  async markViewed(id: string, userId: string) {
    const exists = await this.prisma.jobPost.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException(`JobPost ${id} not found`);

    const row = await this.prisma.jobPostView.upsert({
      where: { userId_jobPostId: { userId, jobPostId: id } },
      update: { viewedAt: new Date() },
      create: { userId, jobPostId: id },
      select: { viewedAt: true },
    });

    return { viewedAt: row.viewedAt.toISOString() };
  }

  async remove(id: string) {
    const jobPost = await this.prisma.jobPost.findUnique({ where: { id } });
    if (!jobPost) throw new NotFoundException(`JobPost ${id} not found`);
    await this.prisma.jobPost.delete({ where: { id } });
    // Drop any pending BullMQ job for this id — otherwise waiting /
    // paused tasks for a deleted row keep accumulating in Redis
    // (worker-guard then no-ops them, but memory still grows). We
    // never remove an `active` job here — forgetJob is idempotent
    // and best-effort; a failure is logged by the queue service.
    await this.queue.forgetJob(id).catch(() => undefined);
  }

  /**
   * Bulk delete under the same permission as single-remove. Stale
   * ids are silently skipped — the response reports the actual
   * matched row count via `deleted`. Also drops any pending BullMQ
   * job for every id so Redis doesn't accumulate orphan tasks.
   */
  async bulkRemove(ids: string[]): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const result = await this.prisma.jobPost.deleteMany({
      where: { id: { in: ids } },
    });
    await Promise.all(
      ids.map((id) => this.queue.forgetJob(id).catch(() => undefined)),
    );
    if (result.count > 0) {
      this.liveEvents.emitJobPostChanged('skipped');
    }
    return { deleted: result.count };
  }

  /**
   * Live counters for the scanner panel. Separates the two
   * durability domains with semantically clear buckets. The frontend
   * must NOT sum Postgres + Redis values — they describe the same
   * posts from different vantage points.
   *
   *   Postgres (durable, source of truth for "work still owed"):
   *     • totalNew   — every status=NEW row (BACKLOG + PENDING +
   *                    ENQUEUED + legacy NULL combined). This is
   *                    the number the Resume AI modal operates on.
   *     • backlog    — status=NEW AND enqueueState in {BACKLOG, NULL}
   *                    (waiting for operator strategy decision; AI
   *                    does NOT pick these up automatically).
   *     • pending    — status=NEW AND enqueueState=PENDING (DB says
   *                    "should be in Redis"; scheduler will push).
   *     • failed     — status=FAILED.
   *
   *   Redis / BullMQ (volatile, best-effort observation):
   *     • inQueue    — waiting + delayed + paused + prioritized
   *                    (posts truly sitting in Redis, by their own
   *                    terminology, including the paused bucket).
   *     • running    — active (worker is executing right now).
   *
   *   Health:
   *     • redisAvailable — false if the queueCounts() round-trip
   *                        threw. The DB counters are still returned
   *                        when Redis is down; UI shows Redis-side
   *                        values as "unavailable", not as zero.
   */
  async getQueueStats() {
    const [analysisEnabled, dbCounts, queueCountsResult] = await Promise.all([
      this.settings.getBooleanForKey(SK.SCANNER_ANALYSIS_ENABLED, true),
      this.prisma.jobPost.groupBy({
        by: ['status', 'enqueueState'],
        _count: { _all: true },
      }),
      this.queue.queueCounts().then(
        (counts) => ({ ok: true as const, counts }),
        (err: unknown) => {
          this.logger.warn(
            `queueCounts failed, reporting Redis as unavailable: ${(err as Error).message}`,
          );
          return { ok: false as const };
        },
      ),
    ]);
    const sum = (
      pred: (row: (typeof dbCounts)[number]) => boolean,
    ) => dbCounts.filter(pred).reduce((s, c) => s + c._count._all, 0);

    const totalNew = sum((c) => c.status === 'NEW');
    const backlog = sum(
      (c) => c.status === 'NEW' && (c.enqueueState === 'BACKLOG' || c.enqueueState === null),
    );
    const pending = sum(
      (c) => c.status === 'NEW' && c.enqueueState === 'PENDING',
    );
    const failed = sum((c) => c.status === 'FAILED');

    const redisAvailable = queueCountsResult.ok;
    const inQueue = redisAvailable
      ? queueCountsResult.counts.waiting +
        queueCountsResult.counts.delayed +
        queueCountsResult.counts.paused +
        queueCountsResult.counts.prioritized
      : null;
    const running = redisAvailable ? queueCountsResult.counts.active : null;

    return {
      analysisEnabled,
      totalNew,
      backlog,
      pending,
      failed,
      inQueue,
      running,
      redisAvailable,
      queueWaiting: redisAvailable ? queueCountsResult.counts.waiting : null,
      queueDelayed: redisAvailable ? queueCountsResult.counts.delayed : null,
      queueActive: redisAvailable ? queueCountsResult.counts.active : null,
      queuePaused: redisAvailable ? queueCountsResult.counts.paused : null,
      queuePrioritized: redisAvailable ? queueCountsResult.counts.prioritized : null,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Distinct city + country pairs for the Country filter's
   * autocomplete. Pure read, substring match on city, ordered by
   * city for stable results. Returns at most `limit` rows.
   *
   * Rows with a null city are skipped — the autocomplete already
   * has a static country list and this endpoint only augments it
   * with real cities seen in the data.
   */
  async citySuggestions(
    q: string | undefined,
    limit: number,
  ): Promise<Array<{ city: string; country: string | null }>> {
    const where: Prisma.JobPostWhereInput = {
      city: { not: null },
      ...(q
        ? { city: { contains: q, mode: 'insensitive' as const } }
        : {}),
    };
    const rows = await this.prisma.jobPost.findMany({
      where,
      select: { city: true, country: true },
      distinct: ['city', 'country'],
      take: Math.max(limit * 3, 30),
      orderBy: { city: 'asc' },
    });
    const seen = new Set<string>();
    const out: Array<{ city: string; country: string | null }> = [];
    for (const r of rows) {
      if (!r.city) continue;
      const key = `${r.city.toLowerCase()}|${(r.country ?? '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ city: r.city, country: r.country });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Read-only preview of what `enableAnalysis` would do under the
   * given strategy / recent-window. Returns the per-strategy split
   * of to-analyse vs to-skip and a cost range for the AI work the
   * "to-analyse" side would do.
   *
   * "Accumulated" is defined as EVERY `status=NEW` row with
   * `createdAt <= snapshotAt`, regardless of enqueueState. That
   * covers both posts that arrived while AI was paused (BACKLOG or
   * legacy NULL) AND posts that were still waiting in Redis from
   * before the pause (PENDING / ENQUEUED). PROCESSING / terminal
   * rows are intentionally excluded. No state is changed, no queue
   * push, no AI call.
   */
  async previewEnableAnalysis(dto: PreviewEnableAnalysisDto): Promise<{
    strategy: EnableAnalysisStrategy;
    snapshotAt: string;
    toAnalyse: number;
    toSkip: number;
    totalBacklog: number;
    costUsd: { min: number; max: number; expected: number };
    assumptions: {
      pricingPerMTok: typeof PRICING;
      models: { haiku: string; sonnet: string };
      cacheMinPrefixTokens: number;
      avgTokens: { haiku: { input: number; output: number }; sonnet: { input: number; output: number } };
      sonnetPassthroughRange: { low: number; high: number };
      note: string;
      usedUsageHistory: boolean;
      cacheHitsObserved: boolean;
    };
  }> {
    const snapshotAt = new Date();
    // Preview uses the SAME scope as enableAnalysis: every status=NEW
    // row at or before the snapshot regardless of enqueueState —
    // BACKLOG + legacy NULL + PENDING + ENQUEUED. "Skip accumulated"
    // means skip the entire accumulated backlog including pending
    // Redis jobs from before the pause, so after Resume the AI
    // processes NEW incoming posts rather than the old queue.
    // First-call-wins protection against re-skipping an already-
    // approved backlog is enforced inside enableAnalysis via the
    // row-level FOR UPDATE on the Setting + an `alreadyEnabled`
    // short-circuit (NOT by narrowing baseWhere).
    const baseWhere: Prisma.JobPostWhereInput = {
      status: 'NEW',
      createdAt: { lte: snapshotAt },
    };

    const totalBacklog = await this.prisma.jobPost.count({ where: baseWhere });

    let toAnalyse = 0;
    let toSkip = 0;

    if (dto.strategy === EnableAnalysisStrategy.ALL) {
      toAnalyse = totalBacklog;
    } else if (dto.strategy === EnableAnalysisStrategy.NEW_POSTS_ONLY) {
      // Skip accumulated: zero AI cost for the backlog.
      toSkip = totalBacklog;
    } else {
      // CANCEL / RECENT (not exposed in UI) — preview reports zero.
    }

    // Prefer the real average usage from recent PROCESSED posts
    // whose logged `usage.model` matches the CURRENT configured
    // gate/eval model IDs. If no matching sample exists, fall back
    // to the conservative constants — never silently reuse Haiku 4.5
    // numbers for a Haiku 5.5 projection.
    const haikuModel = this.evaluator.gateModel();
    const sonnetModel = this.evaluator.evalModel();
    const usageAvg = await this.loadRecentUsageAverages({ haikuModel, sonnetModel });
    const haikuTokens = usageAvg.haiku ?? AVG_TOKENS_FALLBACK.haiku;
    const sonnetTokens = usageAvg.sonnet ?? AVG_TOKENS_FALLBACK.sonnet;

    const haikuCost = costPerPost('haiku', haikuTokens);
    const sonnetCost = costPerPost('sonnet', sonnetTokens);
    // min = everyone decline-at-gate (Haiku only).
    // max = everyone passes the gate (Haiku + Sonnet).
    // expected = Haiku for everyone + Sonnet share at the midpoint of
    //            the observed 10–20 % pass-through range.
    const expectedShare = (SONNET_PASSTHROUGH_LOW + SONNET_PASSTHROUGH_HIGH) / 2;
    const minCost = toAnalyse * haikuCost;
    const maxCost = toAnalyse * (haikuCost + sonnetCost);
    const expectedCost = toAnalyse * (haikuCost + sonnetCost * expectedShare);

    return {
      strategy: dto.strategy,
      snapshotAt: snapshotAt.toISOString(),
      toAnalyse,
      toSkip,
      totalBacklog,
      costUsd: {
        min: Math.round(minCost * 10000) / 10000,
        max: Math.round(maxCost * 10000) / 10000,
        expected: Math.round(expectedCost * 10000) / 10000,
      },
      assumptions: {
        pricingPerMTok: PRICING,
        models: { haiku: haikuModel, sonnet: sonnetModel },
        cacheMinPrefixTokens: CACHE_MIN_PREFIX_TOKENS,
        avgTokens: { haiku: haikuTokens, sonnet: sonnetTokens },
        sonnetPassthroughRange: {
          low: SONNET_PASSTHROUGH_LOW,
          high: SONNET_PASSTHROUGH_HIGH,
        },
        note:
          usageAvg.haiku || usageAvg.sonnet
            ? `Token averages are measured from recent PROCESSED posts on the current ${
                haikuModel
              } / ${sonnetModel} models. This is an estimate, not a guaranteed maximum. Prompt-cache savings are NOT applied — the preview assumes cache misses on every post.`
            : `No PROCESSED usage history on ${haikuModel}/${sonnetModel} yet — token averages are conservative fallback estimates. Historical usage from other models was intentionally excluded. The range (min / expected / max) is operator-facing guidance, not a guaranteed maximum.`,
        usedUsageHistory: Boolean(usageAvg.haiku || usageAvg.sonnet),
        cacheHitsObserved: usageAvg.cacheHitsObserved,
      },
    };
  }

  /**
   * Pulls the last few hundred PROCESSED posts and averages their
   * stage-level token usage out of `aiResponse.gatekeeper.usage` and
   * `aiResponse.evaluation.usage`. Returns `null` for either stage
   * whose history is empty — the preview falls back to constants
   * then. Also surfaces whether any cache read has ever been
   * observed, so the UI can state the cache status honestly.
   */
  /**
   * Average per-stage usage from the last PROCESSED posts, **filtered
   * to the currently-configured model IDs**. Rows evaluated under a
   * previous model (e.g. Haiku 4.5 before the 5.5 upgrade) are
   * ignored for cost projection — mixing their token/price profile
   * with the current model would understate or overstate the preview.
   * The caller falls back to AVG_TOKENS_FALLBACK when either stage
   * has no matching sample.
   *
   * `cacheHitsObserved` is `true` only when a real
   * `cache_read_input_tokens > 0` was recorded for the current
   * model — never from the mere presence of a cache_control marker.
   */
  private async loadRecentUsageAverages(opts: {
    haikuModel: string;
    sonnetModel: string;
  }): Promise<{
    haiku: { input: number; output: number } | null;
    sonnet: { input: number; output: number } | null;
    cacheHitsObserved: boolean;
  }> {
    const rows = await this.prisma.jobPost.findMany({
      where: { status: 'PROCESSED', aiResponse: { not: Prisma.AnyNull } },
      orderBy: { processedAt: 'desc' },
      take: 400,
      select: { aiResponse: true },
    });

    let haikuIn = 0;
    let haikuOut = 0;
    let haikuN = 0;
    let sonnetIn = 0;
    let sonnetOut = 0;
    let sonnetN = 0;
    let cacheHits = false;

    for (const r of rows) {
      const ai = r.aiResponse as unknown as {
        gatekeeper?: {
          usage?: {
            model?: string;
            inputTokens?: number;
            outputTokens?: number;
            cacheReadInputTokens?: number;
          };
        };
        evaluation?: {
          usage?: {
            model?: string;
            inputTokens?: number;
            outputTokens?: number;
            cacheReadInputTokens?: number;
          };
        };
      } | null;
      if (!ai) continue;
      const g = ai.gatekeeper?.usage;
      if (g && g.model === opts.haikuModel) {
        haikuIn += g.inputTokens ?? 0;
        haikuOut += g.outputTokens ?? 0;
        haikuN += 1;
        if ((g.cacheReadInputTokens ?? 0) > 0) cacheHits = true;
      }
      const e = ai.evaluation?.usage;
      if (e && e.model === opts.sonnetModel) {
        sonnetIn += e.inputTokens ?? 0;
        sonnetOut += e.outputTokens ?? 0;
        sonnetN += 1;
        if ((e.cacheReadInputTokens ?? 0) > 0) cacheHits = true;
      }
    }

    return {
      haiku:
        haikuN > 0
          ? { input: Math.round(haikuIn / haikuN), output: Math.round(haikuOut / haikuN) }
          : null,
      sonnet:
        sonnetN > 0
          ? { input: Math.round(sonnetIn / sonnetN), output: Math.round(sonnetOut / sonnetN) }
          : null,
      cacheHitsObserved: cacheHits,
    };
  }

  /**
   * Apply the operator's backlog strategy and flip
   * `scanner.analysisEnabled` on. Atomic in Postgres only — the
   * actual Redis push for every PENDING row is left to the
   * scheduler's next tick, which is idempotent (deterministic
   * BullMQ jobId). This separation keeps the DB transaction short
   * and avoids coupling two availability domains.
   *
   * The strategy applies to a SNAPSHOT of the BACKLOG at the start
   * of the call (`createdAt <= snapshotAt`). Posts that arrive
   * after that point land as BACKLOG or PENDING per the normal
   * ingestion rules and are NOT collaterally marked SKIPPED.
   */
  async enableAnalysis(
    dto: EnableAnalysisDto,
  ): Promise<{
    strategy: EnableAnalysisStrategy;
    snapshotAt: string;
    enqueued: number;
    skipped: number;
    analysisEnabled: boolean;
  }> {
    const snapshotAt = new Date();

    if (dto.strategy === EnableAnalysisStrategy.CANCEL) {
      // No state change; also do NOT flip the setting. "Cancel" is
      // the operator saying "never mind, I'm not resuming yet".
      const flag = await this.settings.getBooleanForKey(
        SK.SCANNER_ANALYSIS_ENABLED,
        true,
      );
      return {
        strategy: dto.strategy,
        snapshotAt: snapshotAt.toISOString(),
        enqueued: 0,
        skipped: 0,
        analysisEnabled: flag,
      };
    }

    // Atomic in Postgres: flag flip AND backlog strategy run in
    // ONE transaction, serialised by `SELECT … FOR UPDATE` on the
    // Setting row (inside `applyBooleanInsideTx`).
    //
    //   • Strategy throws   → DB rollback → flag NOT flipped. The
    //                         operator sees the error and can retry.
    //   • Two concurrent    → the second blocks on the row-level
    //     enable calls         lock. After it acquires the lock it
    //                         re-reads the committed flag. If AI was
    //                         ALREADY on (first call succeeded), the
    //                         second call is a no-op: it returns
    //                         {enqueued:0, skipped:0}. The baseWhere
    //                         is also scoped to BACKLOG+NULL only,
    //                         so rows the first call moved to
    //                         PENDING are NOT re-decided by the
    //                         second — a Process+Skip race cannot
    //                         retroactively skip approved work.
    //   • Mid-call ingest   → the row lock on Setting blocks the
    //                         ingestion processor's `getBooleanInsideTx`
    //                         read for `scanner.analysisEnabled`;
    //                         by the time it proceeds the flag is
    //                         either committed=true (ingestion lands
    //                         as PENDING) or rolled back=false
    //                         (ingestion lands as BACKLOG). The
    //                         `createdAt <= snapshotAt` bound alone
    //                         doesn't guarantee this — the lock
    //                         does.
    //
    // Redis `queue.resume()` runs AFTER commit. If it fails, the
    // scheduler's reconcilePauseState tick (every 30s) brings the
    // queue back in line with the DB flag — no manual retry needed.
    const { enqueued, skipped, skippedIds, alreadyEnabled } =
      await this.prisma.$transaction(async (tx) => {
        // Re-read the live flag UNDER an exclusive row-level lock
        // on the Setting row BEFORE flipping it. One call does both
        // the SELECT ... FOR UPDATE and the read — we deliberately
        // do NOT first take FOR SHARE and then upgrade to FOR UPDATE
        // because Postgres deadlocks on two concurrent upgrades of
        // that kind. A concurrent enable call that already committed
        // will show `was === true` here, in which case we DON'T
        // apply this strategy to the backlog — the first call made
        // the Process/Skip decision already, and the second
        // shouldn't retroactively flip rows the first approved.
        const was = await this.settings.getBooleanForUpdateInsideTx(
          tx,
          SK.SCANNER_ANALYSIS_ENABLED,
          false,
        );
        await this.settings.applyBooleanInsideTx(
          tx,
          SK.SCANNER_ANALYSIS_ENABLED,
          true,
        );
        if (was === true) {
          return {
            enqueued: 0,
            skipped: 0,
            skippedIds: [] as string[],
            alreadyEnabled: true,
          };
        }

        // "Accumulated" means every NEW row at or before the
        // snapshot regardless of enqueueState: BACKLOG, legacy NULL,
        // PENDING AND ENQUEUED. Skip accumulated therefore also
        // discards pre-pause Redis-queued jobs — after Resume the
        // AI resumes on NEW incoming posts rather than the old
        // backlog. Protection against a second confirmation
        // re-skipping work already approved by the first lives in
        // the `alreadyEnabled` short-circuit above, under the row-
        // level FOR UPDATE on the Setting row.
        // PROCESSING / terminal rows are excluded by `status: 'NEW'`,
        // and the `updateMany` statements below re-check `status:
        // 'NEW'` directly so a worker that captured a row between
        // our `findMany` and `updateMany` is NOT overwritten.
        const baseWhere: Prisma.JobPostWhereInput = {
          status: 'NEW',
          createdAt: { lte: snapshotAt },
        };

        let enqueued = 0;
        let skipped = 0;
        let skippedIds: string[] = [];

        if (dto.strategy === EnableAnalysisStrategy.ALL) {
          const res = await tx.jobPost.updateMany({
            where: baseWhere,
            data: { enqueueState: 'PENDING' },
          });
          enqueued = res.count;
        } else if (dto.strategy === EnableAnalysisStrategy.RECENT) {
          if (!dto.recent) {
            throw new Error('`recent` window required for strategy=recent');
          }
          const cutoff = new Date(
            snapshotAt.getTime() - dto.recent.hours * 60 * 60 * 1000,
          );
          const enq = await tx.jobPost.updateMany({
            where: { ...baseWhere, createdAt: { gte: cutoff, lte: snapshotAt } },
            data: { enqueueState: 'PENDING' },
          });
          enqueued = enq.count;
          const olderRows = await tx.jobPost.findMany({
            where: { ...baseWhere, createdAt: { lt: cutoff } },
            select: { id: true },
          });
          skippedIds = olderRows.map((r) => r.id);
          // Re-check status=NEW on each update so a worker that
          // grabbed one of these rows between findMany and this
          // write (unlikely under the Setting row lock, but defence
          // in depth) is NOT overwritten.
          const skp = await tx.jobPost.updateMany({
            where: { id: { in: skippedIds }, status: 'NEW' },
            data: { status: 'SKIPPED', enqueueState: null, processedAt: new Date() },
          });
          skipped = skp.count;
        } else {
          // NEW_POSTS_ONLY: mark SKIPPED for every awaiting-decision
          // row. We need the ids out so we can drop their (unlikely)
          // Redis jobs right after the DB commits.
          const rows = await tx.jobPost.findMany({
            where: baseWhere,
            select: { id: true },
          });
          skippedIds = rows.map((r) => r.id);
          const res = await tx.jobPost.updateMany({
            where: { id: { in: skippedIds }, status: 'NEW' },
            data: { status: 'SKIPPED', enqueueState: null, processedAt: new Date() },
          });
          skipped = res.count;
        }

        return { enqueued, skipped, skippedIds, alreadyEnabled: false };
      });

    // DB committed. Now drop the matching jobs from Redis so the
    // worker doesn't bother picking them up only to find
    // status!=NEW and bail out. If a `forgetJob` call fails the
    // worker guard (`updateMany where id, status:NEW`) still
    // short-circuits the processing path, so this is a best-effort
    // optimisation — not a safety-critical step.
    if (skippedIds.length) {
      await Promise.all(
        skippedIds.map((id) => this.queue.forgetJob(id).catch(() => undefined)),
      );
    }

    // Commit succeeded. Drop the in-process settings cache for the
    // flag + resume BullMQ. Both are best-effort: if either fails,
    // the scheduler's reconcilePauseState re-asserts the correct
    // Redis state within 30s, and `getBooleanForKey` will refetch
    // from DB when the cache expires on its own 60s TTL anyway.
    this.settings.invalidateCachePublic(SK.SCANNER_ANALYSIS_ENABLED);
    await this.queue.resume().catch((err) => {
      this.logger.warn(
        `enableAnalysis: queue.resume failed, scheduler will reconcile: ${(err as Error).message}`,
      );
    });

    // Fan out live-event updates. Emitted AFTER the DB commit AND
    // after the queue.resume() attempt so a subscriber receiving
    // this tick is guaranteed to also see the fresh queue counters.
    this.liveEvents.emitSettingsScanner(true);
    this.liveEvents.emitJobPostChanged('enqueue-decision');

    this.logger.log(
      `enableAnalysis: strategy=${dto.strategy} snapshotAt=${snapshotAt.toISOString()}` +
        ` enqueued=${enqueued} skipped=${skipped}` +
        (alreadyEnabled ? ' (no-op: AI was already on when lock acquired)' : ''),
    );

    return {
      strategy: dto.strategy,
      snapshotAt: snapshotAt.toISOString(),
      enqueued,
      skipped,
      analysisEnabled: true,
    };
  }

  /**
   * Retry FAILED posts only. The server narrows the set here so
   * even a client that sends mixed ids can't accidentally re-run
   * a PROCESSED verdict or restart a NEW/BACKLOG row. Operator
   * flow: triage the Failed-filtered list, pick the ones whose
   * cause is now fixed, hit Retry.
   *
   * Behaviour:
   *   - `status: FAILED → NEW` with `enqueueState: PENDING` and
   *     `lastAnalysisError: null`. The post is now a valid pick
   *     for the scheduler's reconcile tick.
   *   - `analysisAttempts` is NOT reset — the attempt history is
   *     diagnostic value we want to keep.
   *   - NEW / SKIPPED / PROCESSING / PROCESSED rows in the id set
   *     are silently ignored by the `where` clause.
   *   - When AI is paused (`scanner.analysisEnabled=false`), this
   *     action does NOT flip the flag. The row sits as
   *     `NEW/PENDING` until the operator resumes AI via the Sales
   *     Analytics panel, at which point the normal pipeline picks
   *     it up (deterministic BullMQ jobId handles de-dup).
   *   - Stale BullMQ terminal-state jobs for the id are dropped
   *     via `queue.forgetJob` so the scheduler's next add is
   *     accepted fresh.
   */
  async bulkAnalyze(ids: string[]): Promise<{ requeued: number }> {
    if (ids.length === 0) return { requeued: 0 };
    const result = await this.prisma.jobPost.updateMany({
      where: { id: { in: ids }, status: 'FAILED' },
      data: {
        status: 'NEW',
        enqueueState: 'PENDING',
        lastAnalysisError: null,
      },
    });
    await Promise.all(ids.map((id) => this.queue.forgetJob(id).catch(() => undefined)));
    if (result.count > 0) {
      this.liveEvents.emitJobPostChanged('enqueue-decision');
    }
    return { requeued: result.count };
  }

  /**
   * Explicit bulk skip. Only NEW rows are affected — SKIPPED/
   * PROCESSED/PROCESSING/FAILED are left alone so this cannot
   * overwrite completed analysis or interrupt a worker mid-run.
   *
   * A race between Skip and a worker starting analysis: the worker
   * takes the row via `updateMany where status='NEW' → PROCESSING`;
   * if that fires first, Skip's `where status='NEW'` returns zero
   * — Skip is a no-op and the AI call completes normally. If Skip
   * fires first, the worker's `updateMany` returns zero and the
   * worker exits early without any AI call. Either order is safe.
   *
   * We also drop the pending BullMQ job to save compute.
   */
  async bulkSkip(ids: string[]): Promise<{ skipped: number }> {
    if (ids.length === 0) return { skipped: 0 };
    const result = await this.prisma.jobPost.updateMany({
      where: { id: { in: ids }, status: 'NEW' },
      data: {
        status: 'SKIPPED',
        enqueueState: null,
        processedAt: new Date(),
      },
    });
    await Promise.all(ids.map((id) => this.queue.forgetJob(id).catch(() => undefined)));
    return { skipped: result.count };
  }

  async convertToProposal(
    id: string,
    dto: ConvertToProposalDto,
    userId: string,
  ) {
    const jobPost = await this.prisma.jobPost.findUnique({
      where: { id },
      include: { proposal: true },
    });

    if (!jobPost) throw new NotFoundException(`JobPost ${id} not found`);
    if (jobPost.proposal)
      throw new ConflictException('Proposal already exists for this job post');

    const upwork = await this.prisma.platform.findUniqueOrThrow({
      where: { slug: 'upwork' },
    });

    const isBid = dto.proposalType === ProposalType.Bid;

    return this.prisma.proposal.create({
      data: {
        title: jobPost.title ?? jobPost.rawText.slice(0, 100),
        jobUrl: jobPost.jobUrl,
        vacancy: jobPost.rawText,
        proposalType: dto.proposalType,
        source: ProposalSource.telegram,
        platformId: upwork.id,
        boosted: isBid ? (dto.boosted ?? false) : false,
        connects: isBid ? (dto.connects ?? 0) : 0,
        boostedConnects: isBid && dto.boosted ? (dto.boostedConnects ?? 0) : 0,
        userId,
        jobPostId: jobPost.id,
      },
    });
  }
}
