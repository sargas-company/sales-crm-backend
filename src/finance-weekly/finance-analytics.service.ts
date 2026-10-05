import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

// Only these statuses represent money (actual or expected). `no_work` is
// excluded from every aggregation — it is a scheduling signal, not revenue.
const MONEY_STATUSES: PaymentStatus[] = [
  'received',
  'in_transit',
  'expected_this_month',
  'expected_later',
  'planned_invoice',
];
const PIPELINE_STATUSES: PaymentStatus[] = [
  'in_transit',
  'expected_this_month',
  'expected_later',
  'planned_invoice',
];

function formatClientName(
  c: { firstName: string; lastName: string; company: string | null } | null,
): string {
  if (!c) return 'Unassigned';
  const person = `${c.firstName} ${c.lastName}`.trim();
  const company = (c.company ?? '').trim();
  if (company && person) return `${company} · ${person}`;
  return company || person || 'Unassigned';
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toNumber(v: Prisma.Decimal | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : 0;
}

export interface AnalyticsSnapshot {
  receivedThisMonth: number;
  pipelineThisMonth: number;
  receivedYtd: number;
  prevMonthReceived: number;
  deltaMoM: number | null; // percent, null when prev is 0
}

export interface AnalyticsMonthly {
  year: number;
  months: Array<{
    monthId: string;
    label: string;
    sequenceInYear: number;
    received: number;
    pipeline: number;
    entriesReceived: number;
  }>;
  average: number;
}

export interface AnalyticsBreakdown {
  key: string;
  label: string;
  sub: string | null;
  received: number;
  pipeline: number;
  entriesReceived: number;
  percent: number;
}

export interface AnalyticsPipeline {
  in_transit: { total: number; count: number };
  expected_this_month: { total: number; count: number };
  expected_later: { total: number; count: number };
  planned_invoice: { total: number; count: number };
  totalPipeline: number;
}

export interface AnalyticsYear {
  year: number;
  totalReceived: number;
  avgMonthly: number;
  bestMonth: { label: string; total: number } | null;
  worstMonth: { label: string; total: number } | null;
  paymentsCount: number;
  activeProjects: number;
  activeClients: number;
}

export interface AnalyticsConcentration {
  topClientPercent: number;
  topThreePercent: number;
  atRisk: boolean;
}

export interface AnalyticsResponse {
  filters: {
    year: number;
    from: string | null;
    to: string | null;
    projectId: string | null;
    clientId: string | null;
    rangeLabel: string;
  };
  snapshot: AnalyticsSnapshot;
  monthly: AnalyticsMonthly;
  byProject: AnalyticsBreakdown[];
  byClient: AnalyticsBreakdown[];
  concentration: AnalyticsConcentration;
  pipeline: AnalyticsPipeline;
  yearOverview: AnalyticsYear;
}

@Injectable()
export class FinanceAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(query: AnalyticsQueryDto): Promise<AnalyticsResponse> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const year = query.year ?? today.getUTCFullYear();

    // Resolve the range for by-project / by-client / pipeline.
    const range = this.resolveRange(query, today, year);

    // Fetch all money-status entries for the selected year (used for monthly
    // history + snapshot deltas). Small dataset — one query, all math in JS.
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31));

    const yearEntries = await this.prisma.weeklyEntry.findMany({
      where: {
        status: { in: MONEY_STATUSES },
        fiscalWeek: {
          startDate: { lte: yearEnd },
          endDate: { gte: yearStart },
        },
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.clientId
          ? { project: { clientId: query.clientId } }
          : {}),
      },
      include: {
        fiscalWeek: {
          include: {
            fiscalMonth: { select: { id: true, label: true, sequenceInYear: true, year: true } },
          },
        },
        project: {
          select: {
            id: true,
            name: true,
            clientId: true,
            client: { select: { firstName: true, lastName: true, company: true } },
          },
        },
      },
    });

    // Fetch entries limited to the by-project / by-client range (usually
    // a subset of yearEntries — do a separate query since range may go
    // beyond the year for "custom").
    const rangeEntries = await this.prisma.weeklyEntry.findMany({
      where: {
        status: { in: MONEY_STATUSES },
        fiscalWeek: {
          ...(range.fromDate ? { endDate: { gte: range.fromDate } } : {}),
          ...(range.toDate ? { startDate: { lte: range.toDate } } : {}),
        },
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.clientId
          ? { project: { clientId: query.clientId } }
          : {}),
      },
      include: {
        fiscalWeek: { select: { startDate: true, endDate: true } },
        project: {
          select: {
            id: true,
            name: true,
            clientId: true,
            client: { select: { firstName: true, lastName: true, company: true } },
          },
        },
      },
    });

    const fiscalMonths = await this.prisma.fiscalMonth.findMany({
      where: { year },
      orderBy: { sequenceInYear: 'asc' },
      select: {
        id: true,
        label: true,
        sequenceInYear: true,
        startDate: true,
        endDate: true,
      },
    });

    const currentMonth = fiscalMonths.find(
      (m) => m.startDate <= today && m.endDate >= today,
    );
    const currentMonthIdx = currentMonth ? currentMonth.sequenceInYear - 1 : -1;
    const prevMonth = currentMonthIdx > 0 ? fiscalMonths[currentMonthIdx - 1] : null;

    /* Snapshot ─────────────────────────────────────── */
    let receivedThisMonth = 0;
    let pipelineThisMonth = 0;
    let receivedYtd = 0;
    let prevMonthReceived = 0;

    for (const e of yearEntries) {
      const amount = toNumber(e.amount);
      const mid = e.fiscalWeek.fiscalMonth.id;
      if (e.status === 'received') {
        receivedYtd += amount;
        if (currentMonth && mid === currentMonth.id) receivedThisMonth += amount;
        if (prevMonth && mid === prevMonth.id) prevMonthReceived += amount;
      } else if (currentMonth && mid === currentMonth.id) {
        pipelineThisMonth += amount;
      }
    }

    const deltaMoM =
      prevMonthReceived > 0
        ? ((receivedThisMonth - prevMonthReceived) / prevMonthReceived) * 100
        : null;

    /* Monthly history ─────────────────────────────── */
    const monthAgg = new Map<
      string,
      { received: number; pipeline: number; entriesReceived: number }
    >();
    for (const m of fiscalMonths) monthAgg.set(m.id, { received: 0, pipeline: 0, entriesReceived: 0 });

    for (const e of yearEntries) {
      const mid = e.fiscalWeek.fiscalMonth.id;
      const bucket = monthAgg.get(mid);
      if (!bucket) continue;
      const amount = toNumber(e.amount);
      if (e.status === 'received') {
        bucket.received += amount;
        bucket.entriesReceived += 1;
      } else {
        bucket.pipeline += amount;
      }
    }

    const monthlyRows = fiscalMonths.map((m) => {
      const agg = monthAgg.get(m.id) ?? { received: 0, pipeline: 0, entriesReceived: 0 };
      return {
        monthId: m.id,
        label: m.label,
        sequenceInYear: m.sequenceInYear,
        received: agg.received,
        pipeline: agg.pipeline,
        entriesReceived: agg.entriesReceived,
      };
    });
    const withReceived = monthlyRows.filter((m) => m.received > 0);
    const avgMonthly = withReceived.length
      ? withReceived.reduce((s, m) => s + m.received, 0) / withReceived.length
      : 0;

    /* By project ─────────────────────────────────── */
    type BucketKey = string;
    const projectBuckets = new Map<
      BucketKey,
      { label: string; sub: string | null; received: number; pipeline: number; entriesReceived: number }
    >();
    const clientBuckets = new Map<
      BucketKey,
      { label: string; sub: string | null; received: number; pipeline: number; entriesReceived: number }
    >();

    for (const e of rangeEntries) {
      const amount = toNumber(e.amount);
      const isReceived = e.status === 'received';

      // Project bucket
      const pKey = e.project.id;
      const pBucket = projectBuckets.get(pKey) ?? {
        label: e.project.name,
        sub: formatClientName(e.project.client),
        received: 0,
        pipeline: 0,
        entriesReceived: 0,
      };
      if (isReceived) {
        pBucket.received += amount;
        pBucket.entriesReceived += 1;
      } else {
        pBucket.pipeline += amount;
      }
      projectBuckets.set(pKey, pBucket);

      // Client bucket
      const cKey = e.project.clientId ?? '__unassigned__';
      const cBucket = clientBuckets.get(cKey) ?? {
        label: formatClientName(e.project.client),
        sub: null,
        received: 0,
        pipeline: 0,
        entriesReceived: 0,
      };
      if (isReceived) {
        cBucket.received += amount;
        cBucket.entriesReceived += 1;
      } else {
        cBucket.pipeline += amount;
      }
      clientBuckets.set(cKey, cBucket);
    }

    const totalRangeReceived = Array.from(projectBuckets.values()).reduce(
      (s, b) => s + b.received,
      0,
    );

    const byProject: AnalyticsBreakdown[] = Array.from(projectBuckets.entries())
      .map(([key, b]) => ({
        key,
        label: b.label,
        sub: b.sub,
        received: b.received,
        pipeline: b.pipeline,
        entriesReceived: b.entriesReceived,
        percent: totalRangeReceived > 0 ? (b.received / totalRangeReceived) * 100 : 0,
      }))
      .sort((a, b) => b.received - a.received);

    const byClient: AnalyticsBreakdown[] = Array.from(clientBuckets.entries())
      .map(([key, b]) => ({
        key,
        label: b.label,
        sub: null,
        received: b.received,
        pipeline: b.pipeline,
        entriesReceived: b.entriesReceived,
        percent: totalRangeReceived > 0 ? (b.received / totalRangeReceived) * 100 : 0,
      }))
      .sort((a, b) => b.received - a.received);

    const topClientPercent = byClient[0]?.percent ?? 0;
    const topThreePercent = byClient.slice(0, 3).reduce((s, c) => s + c.percent, 0);

    /* Pipeline breakdown (across range) ─────────── */
    const pipeline: AnalyticsPipeline = {
      in_transit: { total: 0, count: 0 },
      expected_this_month: { total: 0, count: 0 },
      expected_later: { total: 0, count: 0 },
      planned_invoice: { total: 0, count: 0 },
      totalPipeline: 0,
    };
    for (const e of rangeEntries) {
      if (!PIPELINE_STATUSES.includes(e.status)) continue;
      const bucket = pipeline[e.status as keyof AnalyticsPipeline] as
        | { total: number; count: number }
        | undefined;
      if (!bucket) continue;
      const amount = toNumber(e.amount);
      bucket.total += amount;
      bucket.count += 1;
      pipeline.totalPipeline += amount;
    }

    /* Year overview (whole year, ignores range filter) ─ */
    let paymentsCount = 0;
    let totalReceivedYear = 0;
    const activeProjectsYear = new Set<string>();
    const activeClientsYear = new Set<string>();
    for (const e of yearEntries) {
      if (e.status !== 'received') continue;
      paymentsCount += 1;
      totalReceivedYear += toNumber(e.amount);
      activeProjectsYear.add(e.project.id);
      if (e.project.clientId) activeClientsYear.add(e.project.clientId);
    }
    const monthTotalsForYear = monthlyRows
      .map((m) => ({ label: m.label, total: m.received }))
      .filter((m) => m.total > 0);
    const bestMonth = monthTotalsForYear.length
      ? monthTotalsForYear.reduce((a, b) => (b.total > a.total ? b : a))
      : null;
    const worstMonth = monthTotalsForYear.length
      ? monthTotalsForYear.reduce((a, b) => (b.total < a.total ? b : a))
      : null;

    return {
      filters: {
        year,
        from: range.fromDate ? toIso(range.fromDate) : null,
        to: range.toDate ? toIso(range.toDate) : null,
        projectId: query.projectId ?? null,
        clientId: query.clientId ?? null,
        rangeLabel: range.label,
      },
      snapshot: {
        receivedThisMonth,
        pipelineThisMonth,
        receivedYtd,
        prevMonthReceived,
        deltaMoM,
      },
      monthly: {
        year,
        months: monthlyRows,
        average: avgMonthly,
      },
      byProject,
      byClient,
      concentration: {
        topClientPercent,
        topThreePercent,
        atRisk: topClientPercent > 40 || topThreePercent > 70,
      },
      pipeline,
      yearOverview: {
        year,
        totalReceived: totalReceivedYear,
        avgMonthly,
        bestMonth,
        worstMonth,
        paymentsCount,
        activeProjects: activeProjectsYear.size,
        activeClients: activeClientsYear.size,
      },
    };
  }

  private resolveRange(
    query: AnalyticsQueryDto,
    today: Date,
    year: number,
  ): { fromDate: Date | null; toDate: Date | null; label: string } {
    if (query.from || query.to) {
      return {
        fromDate: query.from ? new Date(query.from) : null,
        toDate: query.to ? new Date(query.to) : null,
        label:
          query.from && query.to
            ? `${query.from} — ${query.to}`
            : query.from
              ? `From ${query.from}`
              : `Until ${query.to}`,
      };
    }
    const scope = query.scope ?? 'thisYear';
    if (scope === 'allTime') {
      return { fromDate: null, toDate: null, label: 'All time' };
    }
    if (scope === 'thisMonth') {
      const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
      return { fromDate: from, toDate: to, label: 'This month' };
    }
    if (scope === 'last3Months') {
      const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1));
      return { fromDate: from, toDate: today, label: 'Last 3 months' };
    }
    // thisYear (default)
    return {
      fromDate: new Date(Date.UTC(year, 0, 1)),
      toDate: new Date(Date.UTC(year, 11, 31)),
      label: `${year}`,
    };
  }
}
