import { Injectable } from '@nestjs/common';
import { JobPost, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  AnalyticsFiltersDto,
  ContractTypeFilter,
  SalesDateRangeKey,
} from './dto/analytics-filters.dto';

const DEFAULT_TIMEZONE = 'Europe/Kyiv';
const DEFAULT_DATE_RANGE: SalesDateRangeKey = '7d';
const QUALIFIED_THRESHOLD = 50;
const HOT_THRESHOLD = 75;
const HEATMAP_WEBHOOK_PATH = '/webhooks/vibe-worker/job-post';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

type HeatmapMetric = 'all' | 'qualified' | 'hot' | 'qualifiedRate' | 'averageScore';

export interface HeatmapCell {
  weekdayIndex: number;
  hour: number;
  total: number;
  qualified: number;
  hot: number;
  averageScore: number;
  qualifiedRate: number;
}

export interface HeatmapDailyCell extends HeatmapCell {
  date: string;
}

interface Window {
  from: Date;
  to: Date;
}

const FIXED_BUDGET_BUCKETS = [
  { key: 'lt_1k', label: '< $1k' },
  { key: '1k_3k', label: '$1k–3k' },
  { key: '3k_75k', label: '$3k–7.5k' },
  { key: '75k_15k', label: '$7.5k–15k' },
  { key: 'gt_15k', label: '$15k+' },
];

const HOURLY_BUDGET_BUCKETS = [
  { key: 'lt_25', label: '< $25/h' },
  { key: '25_40', label: '$25–40/h' },
  { key: '40_60', label: '$40–60/h' },
  { key: 'gt_60', label: '$60+/h' },
];

const CLIENT_TIERS = [
  { key: 'elite', label: 'Elite' },
  { key: 'strong', label: 'Strong' },
  { key: 'standard', label: 'Standard' },
  { key: 'new', label: 'New' },
  { key: 'unverified', label: 'Unverified' },
] as const;

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Scanner health ────────────────────────────────────────────────────────

  async getScannerHealth(period: 'today' | '7d' | '30d' = 'today') {
    const now = new Date();
    const window = this.resolveWindow(
      { dateRange: period as SalesDateRangeKey },
      now,
      DEFAULT_TIMEZONE,
    );
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const todayWindow = this.resolveWindow(
      { dateRange: 'today' },
      now,
      DEFAULT_TIMEZONE,
    );

    const [
      lastEvent,
      lastAnalyzed,
      receivedLastHour,
      receivedToday,
      receivedInPeriod,
      analyzedInPeriod,
      errorsInPeriod,
      discordFailuresInPeriod,
    ] = await Promise.all([
      this.prisma.jobPostIngestEvent.findFirst({
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true },
      }),
      this.prisma.jobPostIngestEvent.findFirst({
        where: { processedAt: { not: null } },
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true },
      }),
      this.prisma.jobPostIngestEvent.count({
        where: { receivedAt: { gte: hourAgo } },
      }),
      this.prisma.jobPostIngestEvent.count({
        where: { receivedAt: { gte: todayWindow.from, lt: todayWindow.to } },
      }),
      this.prisma.jobPostIngestEvent.count({
        where: { receivedAt: { gte: window.from, lt: window.to } },
      }),
      this.prisma.jobPostIngestEvent.count({
        where: {
          receivedAt: { gte: window.from, lt: window.to },
          processedAt: { not: null },
        },
      }),
      this.prisma.jobPostIngestEvent.count({
        where: {
          receivedAt: { gte: window.from, lt: window.to },
          error: { not: null },
        },
      }),
      this.prisma.notificationDelivery.count({
        where: {
          channel: 'DISCORD',
          status: 'FAILED',
          createdAt: { gte: window.from, lt: window.to },
        },
      }),
    ]);

    const lastEventAt = lastEvent?.receivedAt ?? null;
    const dataFreshnessSeconds = lastEventAt
      ? Math.max(0, Math.floor((now.getTime() - lastEventAt.getTime()) / 1000))
      : null;

    const status: 'running' | 'delayed' | 'down' | 'idle' = lastEventAt
      ? dataFreshnessSeconds !== null && dataFreshnessSeconds < 15 * 60
        ? 'running'
        : dataFreshnessSeconds !== null && dataFreshnessSeconds < 60 * 60
          ? 'idle'
          : 'delayed'
      : 'idle';

    return {
      status,
      endpoint: HEATMAP_WEBHOOK_PATH,
      lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
      lastAnalyzedAt: lastAnalyzed?.processedAt
        ? lastAnalyzed.processedAt.toISOString()
        : null,
      receivedLastHour,
      receivedToday,
      // No mapper yet → analyzer rate is 0 until Scanner Core finishes.
      processingRatePerHour: 0,
      medianProcessingLatencyMs: null,
      dataFreshnessSeconds,
      webhookErrors: errorsInPeriod,
      analyzerErrors: 0,
      discordDeliveryErrors: discordFailuresInPeriod,
      duplicates: 0,
      period,
      receivedInPeriod,
      analyzedInPeriod,
      discordAlertsInPeriod: 0,
      duplicatesInPeriod: 0,
      errorsInPeriod,
    };
  }

  // ─── Filters options ───────────────────────────────────────────────────────

  async getFiltersOptions() {
    const [technologies, countries] = await Promise.all([
      this.prisma.$queryRaw<{ tech: string }[]>`
        SELECT DISTINCT UNNEST("hSkillsKeywords") AS tech
        FROM "JobPost"
        WHERE "hSkillsKeywords" IS NOT NULL
        ORDER BY tech ASC
      `,
      this.prisma.$queryRaw<{ location: string }[]>`
        SELECT DISTINCT "location" AS location
        FROM "JobPost"
        WHERE "location" IS NOT NULL AND "location" <> ''
        ORDER BY location ASC
      `,
    ]);

    return {
      technologies: technologies.map((r) => r.tech).filter(Boolean),
      // Directions come from Scanner Core AI classification — none produced yet.
      directions: [],
      // Platforms come from Scanner Core mapping — none produced yet.
      platforms: [],
      clientCountries: countries.map((r) => r.location),
      budgetBuckets: [
        ...FIXED_BUDGET_BUCKETS.map((b) => ({
          key: `fixed:${b.key}`,
          label: `Fixed · ${b.label}`,
        })),
        ...HOURLY_BUDGET_BUCKETS.map((b) => ({
          key: `hourly:${b.key}`,
          label: `Hourly · ${b.label}`,
        })),
      ],
      clientTiers: CLIENT_TIERS.map((t) => ({ key: t.key, label: t.label })),
    };
  }

  // ─── Sales overview (KPI) ──────────────────────────────────────────────────

  async getSalesOverview(filters: AnalyticsFiltersDto) {
    const now = new Date();
    const timezone = filters.timezone ?? DEFAULT_TIMEZONE;
    const current = this.resolveWindow(filters, now, timezone);
    const previous = this.previousWindow(current);
    const periodLabel = this.periodLabel(filters);

    const whereBase = this.buildWhere(filters);

    const [cur, prev] = await Promise.all([
      this.aggregateKpi({ ...whereBase, createdAt: { gte: current.from, lt: current.to } }),
      this.aggregateKpi({ ...whereBase, createdAt: { gte: previous.from, lt: previous.to } }),
    ]);

    return {
      period: periodLabel,
      received: this.buildKpi(cur.received, prev.received),
      qualified: this.buildKpi(cur.qualified, prev.qualified),
      hot: this.buildKpi(cur.hot, prev.hot),
      qualifiedRate: this.buildKpi(
        cur.received > 0 ? Math.round((cur.qualified / cur.received) * 100) : 0,
        prev.received > 0 ? Math.round((prev.qualified / prev.received) * 100) : 0,
      ),
      averageScore: this.buildKpi(cur.avgScore, prev.avgScore),
    };
  }

  private async aggregateKpi(where: Prisma.JobPostWhereInput): Promise<{
    received: number;
    qualified: number;
    hot: number;
    avgScore: number;
  }> {
    const [received, qualified, hot, avg] = await Promise.all([
      this.prisma.jobPost.count({ where }),
      this.prisma.jobPost.count({
        where: this.withMatchScoreConstraint(where, {
          gte: QUALIFIED_THRESHOLD,
        }),
      }),
      this.prisma.jobPost.count({
        where: this.withMatchScoreConstraint(where, { gte: HOT_THRESHOLD }),
      }),
      this.prisma.jobPost.aggregate({
        where: this.withMatchScoreConstraint(where, { not: null }),
        _avg: { matchScore: true },
      }),
    ]);
    return {
      received,
      qualified,
      hot,
      avgScore: avg._avg.matchScore != null ? Math.round(avg._avg.matchScore) : 0,
    };
  }

  /**
   * Merge the KPI threshold (e.g. `matchScore >= 50`) with any
   * caller-supplied score constraint (from `filters.scoreMin` /
   * `scoreMax`) using AND semantics. The previous implementation
   * replaced the caller's constraint, so score-range filters were
   * silently ignored when computing qualified / hot / avgScore.
   */
  private withMatchScoreConstraint(
    where: Prisma.JobPostWhereInput,
    extra: Prisma.IntNullableFilter,
  ): Prisma.JobPostWhereInput {
    const existing = where.matchScore;
    if (!existing || typeof existing !== 'object') {
      return { ...where, matchScore: extra };
    }
    // Cast is safe: buildWhere only ever puts an IntNullableFilter here.
    const existingFilter = existing as Prisma.IntNullableFilter;
    const merged: Prisma.IntNullableFilter = { ...existingFilter };
    if (extra.gte !== undefined) {
      merged.gte =
        merged.gte !== undefined && merged.gte !== null
          ? Math.max(Number(merged.gte), Number(extra.gte))
          : (extra.gte as number);
    }
    if (extra.lte !== undefined) {
      merged.lte =
        merged.lte !== undefined && merged.lte !== null
          ? Math.min(Number(merged.lte), Number(extra.lte))
          : (extra.lte as number);
    }
    if (extra.not !== undefined) merged.not = extra.not;
    return { ...where, matchScore: merged };
  }

  private buildKpi(current: number, previous: number) {
    const trendPct =
      previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;
    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (current >= 100) confidence = 'high';
    else if (current >= 30) confidence = 'medium';
    return { current, previous, trendPct, confidence };
  }

  // ─── Opportunity heatmap ───────────────────────────────────────────────────

  async getOpportunityHeatmap(
    filters: AnalyticsFiltersDto,
    metric: HeatmapMetric = 'qualified',
  ) {
    const now = new Date();
    const timezone = filters.timezone ?? DEFAULT_TIMEZONE;
    const window = this.resolveWindow(filters, now, timezone);
    const isDaily = (filters.dateRange ?? DEFAULT_DATE_RANGE) === '30d';

    // Weekly heatmap (7 × 24) — always computed.
    const rows = await this.prisma.$queryRaw<
      { weekday_pg: number; hour: number; total: bigint; qualified: bigint; hot: bigint; avg_score: number | null }[]
    >(
      Prisma.sql`
        SELECT
          EXTRACT(DOW FROM ("createdAt" AT TIME ZONE ${timezone}))::int AS weekday_pg,
          EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE ${timezone}))::int AS hour,
          COUNT(*)::bigint AS total,
          SUM(CASE WHEN "matchScore" >= ${QUALIFIED_THRESHOLD} THEN 1 ELSE 0 END)::bigint AS qualified,
          SUM(CASE WHEN "matchScore" >= ${HOT_THRESHOLD} THEN 1 ELSE 0 END)::bigint AS hot,
          AVG("matchScore")::float AS avg_score
        FROM "JobPost"
        WHERE ${this.buildWhereSql(filters, window)}
        GROUP BY weekday_pg, hour
      `,
    );

    const byKey = new Map<string, HeatmapCell>();
    for (const r of rows) {
      const weekdayIndex = this.pgDowToMondayIdx(r.weekday_pg);
      const total = Number(r.total);
      const qualified = Number(r.qualified);
      const hot = Number(r.hot);
      const averageScore = r.avg_score != null ? Math.round(r.avg_score) : 0;
      const qualifiedRate =
        total > 0 ? Math.round((qualified / total) * 100) : 0;
      byKey.set(`${weekdayIndex}-${r.hour}`, {
        weekdayIndex,
        hour: r.hour,
        total,
        qualified,
        hot,
        averageScore,
        qualifiedRate,
      });
    }

    const cells: HeatmapCell[] = [];
    for (let w = 0; w < 7; w++) {
      for (let h = 0; h < 24; h++) {
        cells.push(
          byKey.get(`${w}-${h}`) ?? {
            weekdayIndex: w,
            hour: h,
            total: 0,
            qualified: 0,
            hot: 0,
            averageScore: 0,
            qualifiedRate: 0,
          },
        );
      }
    }

    const sampleSize = cells.reduce((sum, c) => sum + c.total, 0);
    const maxValue = Math.max(0, ...cells.map((c) => cellValue(c, metric)));

    let dailyCells: HeatmapDailyCell[] | undefined;
    let dailyMaxValue: number | undefined;
    if (isDaily) {
      const dailyRows = await this.prisma.$queryRaw<
        {
          day: Date;
          weekday_pg: number;
          hour: number;
          total: bigint;
          qualified: bigint;
          hot: bigint;
          avg_score: number | null;
        }[]
      >(
        Prisma.sql`
          SELECT
            DATE_TRUNC('day', "createdAt" AT TIME ZONE ${timezone}) AS day,
            EXTRACT(DOW FROM ("createdAt" AT TIME ZONE ${timezone}))::int AS weekday_pg,
            EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE ${timezone}))::int AS hour,
            COUNT(*)::bigint AS total,
            SUM(CASE WHEN "matchScore" >= ${QUALIFIED_THRESHOLD} THEN 1 ELSE 0 END)::bigint AS qualified,
            SUM(CASE WHEN "matchScore" >= ${HOT_THRESHOLD} THEN 1 ELSE 0 END)::bigint AS hot,
            AVG("matchScore")::float AS avg_score
          FROM "JobPost"
          WHERE ${this.buildWhereSql(filters, window)}
          GROUP BY day, weekday_pg, hour
        `,
      );
      dailyCells = dailyRows.map((r) => {
        const total = Number(r.total);
        const qualified = Number(r.qualified);
        const hot = Number(r.hot);
        const averageScore = r.avg_score != null ? Math.round(r.avg_score) : 0;
        const qualifiedRate =
          total > 0 ? Math.round((qualified / total) * 100) : 0;
        return {
          date:
            typeof r.day === 'string'
              ? String(r.day).slice(0, 10)
              : r.day.toISOString().slice(0, 10),
          weekdayIndex: this.pgDowToMondayIdx(r.weekday_pg),
          hour: r.hour,
          total,
          qualified,
          hot,
          averageScore,
          qualifiedRate,
        };
      });
      dailyMaxValue = Math.max(0, ...dailyCells.map((c) => cellValue(c, metric)));
    }

    return {
      timezone,
      metric,
      cells,
      dailyCells,
      sampleSize,
      maxValue,
      dailyMaxValue,
    };
  }

  // ─── Recent high-score posts ───────────────────────────────────────────────

  async getRecentHighScorePosts(filters: AnalyticsFiltersDto, limit = 6) {
    const now = new Date();
    const window = this.resolveWindow(
      filters,
      now,
      filters.timezone ?? DEFAULT_TIMEZONE,
    );
    const where: Prisma.JobPostWhereInput = {
      ...this.buildWhere(filters),
      createdAt: { gte: window.from, lt: window.to },
      matchScore: { gte: QUALIFIED_THRESHOLD },
    };

    const [items, total] = await Promise.all([
      this.prisma.jobPost.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: limit,
      }),
      this.prisma.jobPost.count({ where }),
    ]);

    return {
      items: items.map((p) => this.toSummary(p)),
      total,
    };
  }

  // ─── Job posts page ────────────────────────────────────────────────────────

  async getJobPostsPage(filters: AnalyticsFiltersDto, page = 1, limit = 20) {
    const now = new Date();
    const window = this.resolveWindow(
      filters,
      now,
      filters.timezone ?? DEFAULT_TIMEZONE,
    );
    const where: Prisma.JobPostWhereInput = {
      ...this.buildWhere(filters),
      createdAt: { gte: window.from, lt: window.to },
    };

    const [rows, total] = await Promise.all([
      this.prisma.jobPost.findMany({
        where,
        orderBy: [{ matchScore: 'desc' }, { createdAt: 'desc' }],
        skip: Math.max(0, (page - 1) * limit),
        take: limit,
      }),
      this.prisma.jobPost.count({ where }),
    ]);

    return {
      items: rows.map((p) => this.toMockShape(p)),
      total,
      page,
      limit,
    };
  }

  async getJobPostById(id: string) {
    const row = await this.prisma.jobPost.findUnique({ where: { id } });
    // Preserve contract: contract returns MockJobPost | null on FE.
    return row ? this.toMockShape(row) : null;
  }

  // ─── Mapping helpers ───────────────────────────────────────────────────────

  private toSummary(p: JobPost) {
    return {
      id: p.id,
      title: p.title ?? '',
      score: p.matchScore ?? 0,
      // Directions come from Scanner Core classification → empty for now.
      directions: [] as string[],
      technologies: p.hSkillsKeywords ?? [],
      budgetLabel: this.budgetLabel(p),
      clientCountry: p.location ?? '',
      clientTier: this.clientTier(p),
      // Notifications-per-post link needs Scanner Core mapping → placeholder.
      notificationStatus: 'not_required' as const,
      receivedAt: p.createdAt.toISOString(),
      originalUrl: p.jobUrl ?? undefined,
    };
  }

  private toMockShape(p: JobPost) {
    const contractType = this.contractType(p);
    const summary = this.toSummary(p);
    return {
      ...summary,
      externalId: `${p.chatId}:${p.messageId}`,
      // Platform mapping is Scanner Core territory.
      platformId: '',
      platformName: '',
      description: p.rawText ?? '',
      publishedAt: p.createdAt.toISOString(),
      analyzedAt: (p.processedAt ?? p.createdAt).toISOString(),
      notifiedAt: undefined,
      analysisStatus: this.analysisStatus(p),
      scoreBreakdown: {},
      scoreReasons: [] as string[],
      scoringVersion: 'unknown',
      promptVersion: 'unknown',
      modelVersion: 'unknown',
      contractType,
      fixedBudget: this.fixedBudget(p),
      hourlyRateMin: this.hourlyRateMin(p),
      hourlyRateMax: this.hourlyRateMax(p),
      currency: 'USD',
      duration: undefined,
      workload: undefined,
      unknownTerms: [] as string[],
      clientPaymentVerified: false,
      clientTotalSpent: p.totalSpent ?? undefined,
      clientHireRate: p.hireRate ?? undefined,
      clientRating: undefined,
      clientJobsPosted: undefined,
      clientProposalCountAtScan: undefined,
      goals: [] as string[],
      painPoints: [] as string[],
      deliverables: [] as string[],
      requirements: [] as string[],
      concerns: [] as string[],
      integrations: [] as string[],
      rawPayload: undefined,
    };
  }

  private analysisStatus(
    p: JobPost,
  ): 'pending' | 'processing' | 'completed' | 'failed' {
    switch (p.status) {
      case 'PROCESSED':
        return 'completed';
      case 'PROCESSING':
        return 'processing';
      case 'FAILED':
        return 'failed';
      default:
        return 'pending';
    }
  }

  private contractType(p: JobPost): ContractTypeFilter {
    const b = p.budget?.toLowerCase() ?? '';
    if (b.includes('hour') || b.includes('/h')) return 'hourly';
    if (b.includes('fixed') || b.match(/\$?\d/)) return 'fixed';
    return 'unknown';
  }

  private fixedBudget(p: JobPost): number | undefined {
    if (this.contractType(p) !== 'fixed') return undefined;
    const m = p.budget?.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : undefined;
  }

  private hourlyRateMin(p: JobPost): number | undefined {
    if (this.contractType(p) !== 'hourly') return undefined;
    const m = p.budget?.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)\s*[-–]\s*\$?\s*(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
    const single = p.budget?.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/);
    return single ? Number(single[1]) : undefined;
  }

  private hourlyRateMax(p: JobPost): number | undefined {
    if (this.contractType(p) !== 'hourly') return undefined;
    const m = p.budget?.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)\s*[-–]\s*\$?\s*(\d+(?:\.\d+)?)/);
    if (m) return Number(m[2]);
    const single = p.budget?.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/);
    return single ? Number(single[1]) : undefined;
  }

  private budgetLabel(p: JobPost): string {
    const fixed = this.fixedBudget(p);
    if (this.contractType(p) === 'fixed' && fixed != null) {
      return `$${fixed.toLocaleString('en-US')}`;
    }
    const min = this.hourlyRateMin(p);
    const max = this.hourlyRateMax(p);
    if (this.contractType(p) === 'hourly' && (min != null || max != null)) {
      if (min != null && max != null && min !== max) return `$${min}–${max}/h`;
      return `$${min ?? max}/h`;
    }
    return '—';
  }

  private clientTier(
    p: JobPost,
  ): 'elite' | 'strong' | 'standard' | 'new' | 'unverified' {
    // JobPost has no clientPaymentVerified / clientRating / clientJobsPosted;
    // approximate tier from totalSpent + hireRate until Scanner Core enriches.
    const spent = p.totalSpent ?? 0;
    const hireRate = p.hireRate ?? 0;
    if (spent >= 50000 && hireRate >= 0.5) return 'elite';
    if (spent >= 10000) return 'strong';
    if (spent >= 1000) return 'standard';
    if (spent > 0) return 'new';
    return 'unverified';
  }

  // ─── Filters → Prisma where ────────────────────────────────────────────────

  private buildWhere(filters: AnalyticsFiltersDto): Prisma.JobPostWhereInput {
    const where: Prisma.JobPostWhereInput = {};
    if (filters.scoreMin != null || filters.scoreMax != null) {
      where.matchScore = {};
      if (filters.scoreMin != null)
        (where.matchScore as { gte?: number }).gte = filters.scoreMin;
      if (filters.scoreMax != null)
        (where.matchScore as { lte?: number }).lte = filters.scoreMax;
    }
    if (filters.technology && filters.technology.length > 0) {
      where.hSkillsKeywords = { hasSome: filters.technology };
    }
    if (filters.clientCountry && filters.clientCountry.length > 0) {
      where.location = { in: filters.clientCountry };
    }
    return where;
  }

  private buildWhereSql(
    filters: AnalyticsFiltersDto,
    window: Window,
  ): Prisma.Sql {
    const parts: Prisma.Sql[] = [
      Prisma.sql`"createdAt" >= ${window.from} AND "createdAt" < ${window.to}`,
    ];
    if (filters.scoreMin != null) {
      parts.push(Prisma.sql`"matchScore" >= ${filters.scoreMin}`);
    }
    if (filters.scoreMax != null) {
      parts.push(Prisma.sql`"matchScore" <= ${filters.scoreMax}`);
    }
    if (filters.technology && filters.technology.length > 0) {
      parts.push(
        Prisma.sql`"hSkillsKeywords" && ${filters.technology}::text[]`,
      );
    }
    if (filters.clientCountry && filters.clientCountry.length > 0) {
      parts.push(Prisma.sql`"location" IN (${Prisma.join(filters.clientCountry)})`);
    }
    return Prisma.join(parts, ' AND ');
  }

  // ─── Time window resolution ────────────────────────────────────────────────

  private resolveWindow(
    filters: AnalyticsFiltersDto,
    now: Date,
    timezone: string,
  ): Window {
    const range = filters.dateRange ?? DEFAULT_DATE_RANGE;
    if (range === 'custom' && filters.customFrom && filters.customTo) {
      return {
        from: new Date(filters.customFrom),
        to: new Date(filters.customTo),
      };
    }
    if (range === 'today') {
      const from = this.startOfLocalDay(now, timezone);
      const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
      return { from, to };
    }
    if (range === '7d') {
      const to = new Date(now.getTime());
      const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { from, to };
    }
    if (range === '30d') {
      const to = new Date(now.getTime());
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from, to };
    }
    // Fallback → 7d
    return {
      from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      to: new Date(now.getTime()),
    };
  }

  private previousWindow(w: Window): Window {
    const durationMs = w.to.getTime() - w.from.getTime();
    return {
      from: new Date(w.from.getTime() - durationMs),
      to: new Date(w.from.getTime()),
    };
  }

  private periodLabel(filters: AnalyticsFiltersDto): string {
    switch (filters.dateRange ?? DEFAULT_DATE_RANGE) {
      case 'today':
        return 'Today';
      case '7d':
        return 'Last 7 days';
      case '30d':
        return 'Last 30 days';
      case 'custom':
        return 'Custom period';
    }
  }

  private startOfLocalDay(now: Date, timezone: string): Date {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const [y, m, d] = fmt.format(now).split('-').map((s) => Number(s));
    // Construct UTC-midnight for the local calendar date, then shift back
    // by the offset the timezone had at that instant.
    const utcMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const offsetMin = this.tzOffsetMinutes(utcMidnight, timezone);
    return new Date(utcMidnight.getTime() - offsetMin * 60 * 1000);
  }

  private tzOffsetMinutes(date: Date, timezone: string): number {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(date).map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return (asUtc - date.getTime()) / 60000;
  }

  private pgDowToMondayIdx(dow: number): number {
    // PostgreSQL: 0=Sunday..6=Saturday. FE: 0=Monday..6=Sunday.
    return dow === 0 ? 6 : dow - 1;
  }
}

function cellValue(cell: HeatmapCell, metric: HeatmapMetric): number {
  if (metric === 'all') return cell.total;
  if (metric === 'qualified') return cell.qualified;
  if (metric === 'hot') return cell.hot;
  if (metric === 'qualifiedRate') return cell.qualifiedRate;
  return cell.averageScore;
}

// silence unused label warning in strict builds
void WEEKDAY_LABELS;
