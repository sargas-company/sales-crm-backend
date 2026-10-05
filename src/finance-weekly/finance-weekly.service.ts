import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, PaymentStatus, PaymentRuleType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { UpsertWeeklyEntryDto } from './dto/upsert-weekly-entry.dto';

const STATUS_ORDER: PaymentStatus[] = [
  'received',
  'in_transit',
  'expected_this_month',
  'expected_later',
  'planned_invoice',
  'no_work',
];

const INCOME_STATUSES: PaymentStatus[] = [
  'received',
  'in_transit',
  'expected_this_month',
  'expected_later',
  'planned_invoice',
];

function formatClientName(
  c: { firstName: string; lastName: string; company: string | null } | null,
): string | null {
  if (!c) return null;
  const person = `${c.firstName} ${c.lastName}`.trim();
  const company = (c.company ?? '').trim();
  if (company && person) return `${company} · ${person}`;
  return company || person || null;
}

@Injectable()
export class FinanceWeeklyService {
  constructor(private readonly prisma: PrismaService) {}

  async listFiscalMonths(year?: number) {
    return this.prisma.fiscalMonth.findMany({
      where: year ? { year } : {},
      orderBy: [{ year: 'asc' }, { sequenceInYear: 'asc' }],
      select: {
        id: true,
        year: true,
        sequenceInYear: true,
        startDate: true,
        endDate: true,
        weeksCount: true,
        label: true,
      },
    });
  }

  async getCurrentFiscalMonth(reference?: Date) {
    const ref = reference ?? new Date();
    const month = await this.prisma.fiscalMonth.findFirst({
      where: {
        startDate: { lte: ref },
        endDate: { gte: ref },
      },
    });
    if (month) return month;
    // Fallback: nearest past month
    return this.prisma.fiscalMonth.findFirst({
      where: { startDate: { lte: ref } },
      orderBy: { startDate: 'desc' },
    });
  }

  async overview(monthId: string) {
    const month = await this.prisma.fiscalMonth.findUnique({
      where: { id: monthId },
      include: {
        weeks: {
          orderBy: { indexInMonth: 'asc' },
          include: {
            entries: true,
          },
        },
      },
    });
    if (!month) throw new NotFoundException('Fiscal month not found');

    // Adjacent months for navigation
    const prevKey =
      month.sequenceInYear === 1
        ? { year: month.year - 1, sequenceInYear: 12 }
        : { year: month.year, sequenceInYear: month.sequenceInYear - 1 };
    const nextKey =
      month.sequenceInYear === 12
        ? { year: month.year + 1, sequenceInYear: 1 }
        : { year: month.year, sequenceInYear: month.sequenceInYear + 1 };
    const [prevMonth, nextMonth] = await Promise.all([
      this.prisma.fiscalMonth.findUnique({
        where: { year_sequenceInYear: prevKey },
        select: { id: true, label: true },
      }),
      this.prisma.fiscalMonth.findUnique({
        where: { year_sequenceInYear: nextKey },
        select: { id: true, label: true },
      }),
    ]);

    // All projects (excluding archived) so grid has a stable list.
    const projects = await this.prisma.project.findMany({
      where: { status: { not: 'archived' } },
      select: {
        id: true,
        name: true,
        status: true,
        client: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { name: 'asc' },
    });

    // Weekly entries already loaded via include
    const grid: Record<string, Record<string, EntryCell | null>> = {};
    for (const p of projects) grid[p.id] = {};

    for (const week of month.weeks) {
      for (const p of projects) {
        grid[p.id][week.id] = null;
      }
      for (const e of week.entries) {
        if (!grid[e.projectId]) continue;
        grid[e.projectId][week.id] = {
          id: e.id,
          amount: e.amount ? e.amount.toString() : null,
          status: e.status,
          note: e.note,
          invoiceSentAt: e.invoiceSentAt
            ? e.invoiceSentAt.toISOString().slice(0, 10)
            : null,
          receivedAt: e.receivedAt
            ? e.receivedAt.toISOString().slice(0, 10)
            : null,
          updatedAt: e.updatedAt.toISOString(),
        };
      }
    }

    // KPI
    const allEntries = month.weeks.flatMap((w) => w.entries);
    const kpi = this.computeKpi(allEntries);

    // Predictions: use payment rules
    const rules = await this.getEffectiveRulesForProjects(
      projects.map((p) => p.id),
      month.endDate,
    );
    const predictions = this.computePredictions(
      allEntries,
      month.weeks,
      rules,
      month.endDate,
    );

    return {
      month: {
        id: month.id,
        year: month.year,
        sequenceInYear: month.sequenceInYear,
        label: month.label,
        startDate: month.startDate.toISOString().slice(0, 10),
        endDate: month.endDate.toISOString().slice(0, 10),
        weeksCount: month.weeksCount,
      },
      navigation: {
        prev: prevMonth,
        next: nextMonth,
      },
      weeks: month.weeks.map((w) => ({
        id: w.id,
        indexInMonth: w.indexInMonth,
        startDate: w.startDate.toISOString().slice(0, 10),
        endDate: w.endDate.toISOString().slice(0, 10),
        label: w.label,
      })),
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        clientName: p.client
          ? `${p.client.firstName} ${p.client.lastName}`.trim()
          : null,
      })),
      grid,
      kpi,
      predictions,
      statuses: STATUS_ORDER,
    };
  }

  async listFlat(monthId: string) {
    const month = await this.prisma.fiscalMonth.findUnique({
      where: { id: monthId },
      include: {
        weeks: {
          orderBy: { indexInMonth: 'asc' },
          include: {
            entries: {
              include: {
                project: {
                  select: {
                    id: true,
                    name: true,
                    client: {
                      select: { firstName: true, lastName: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!month) throw new NotFoundException('Fiscal month not found');

    const rows: Array<{
      id: string;
      weekId: string;
      weekLabel: string;
      weekStart: string;
      weekEnd: string;
      projectId: string;
      projectName: string;
      clientName: string | null;
      amount: string | null;
      status: PaymentStatus;
      note: string | null;
      invoiceSentAt: string | null;
      receivedAt: string | null;
    }> = [];

    for (const week of month.weeks) {
      for (const e of week.entries) {
        if (e.status === 'no_work') continue;
        rows.push({
          id: e.id,
          weekId: week.id,
          weekLabel: week.label,
          weekStart: week.startDate.toISOString().slice(0, 10),
          weekEnd: week.endDate.toISOString().slice(0, 10),
          projectId: e.projectId,
          projectName: e.project.name,
          clientName: e.project.client
            ? `${e.project.client.firstName} ${e.project.client.lastName}`.trim()
            : null,
          amount: e.amount ? e.amount.toString() : null,
          status: e.status,
          note: e.note,
          invoiceSentAt: e.invoiceSentAt
            ? e.invoiceSentAt.toISOString().slice(0, 10)
            : null,
          receivedAt: e.receivedAt
            ? e.receivedAt.toISOString().slice(0, 10)
            : null,
        });
      }
    }

    const kpi = this.computeKpi(month.weeks.flatMap((w) => w.entries));

    return {
      month: {
        id: month.id,
        label: month.label,
        startDate: month.startDate.toISOString().slice(0, 10),
        endDate: month.endDate.toISOString().slice(0, 10),
      },
      rows,
      kpi,
    };
  }

  async listEntries(query: {
    from?: string;
    to?: string;
    status?: PaymentStatus;
    projectId?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
    const skip = (page - 1) * pageSize;

    const weekFilter: Prisma.FiscalWeekWhereInput = {};
    if (query.from) weekFilter.endDate = { gte: new Date(query.from) };
    if (query.to) weekFilter.startDate = { lte: new Date(query.to) };

    const where: Prisma.WeeklyEntryWhereInput = {
      status: { not: 'no_work' },
    };
    if (query.status) where.status = query.status;
    if (query.projectId) where.projectId = query.projectId;
    if (Object.keys(weekFilter).length > 0) where.fiscalWeek = weekFilter;

    if (query.search && query.search.trim()) {
      const q = query.search.trim();
      where.OR = [
        { project: { name: { contains: q, mode: 'insensitive' } } },
        {
          project: {
            client: {
              OR: [
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
              ],
            },
          },
        },
        { note: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, entries] = await Promise.all([
      this.prisma.weeklyEntry.count({ where }),
      this.prisma.weeklyEntry.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [{ fiscalWeek: { startDate: 'desc' } }, { project: { name: 'asc' } }],
        include: {
          fiscalWeek: {
            include: {
              fiscalMonth: {
                select: { id: true, label: true, year: true, sequenceInYear: true },
              },
            },
          },
          project: {
            select: {
              id: true,
              name: true,
              client: {
                select: { firstName: true, lastName: true, company: true },
              },
            },
          },
        },
      }),
    ]);

    const rows = entries.map((e) => ({
      id: e.id,
      weekId: e.fiscalWeek.id,
      weekLabel: e.fiscalWeek.label,
      weekStart: e.fiscalWeek.startDate.toISOString().slice(0, 10),
      weekEnd: e.fiscalWeek.endDate.toISOString().slice(0, 10),
      monthId: e.fiscalWeek.fiscalMonth.id,
      monthLabel: e.fiscalWeek.fiscalMonth.label,
      projectId: e.projectId,
      projectName: e.project.name,
      clientName: formatClientName(e.project.client),
      amount: e.amount ? e.amount.toString() : null,
      status: e.status,
      note: e.note,
      invoiceSentAt: e.invoiceSentAt
        ? e.invoiceSentAt.toISOString().slice(0, 10)
        : null,
      receivedAt: e.receivedAt
        ? e.receivedAt.toISOString().slice(0, 10)
        : null,
    }));

    return {
      rows,
      pagination: { page, pageSize, total },
      filters: {
        from: query.from ?? null,
        to: query.to ?? null,
        status: query.status ?? null,
        projectId: query.projectId ?? null,
        search: query.search ?? null,
      },
    };
  }

  async listProjectsSummary() {
    const projects = await this.prisma.project.findMany({
      where: { status: { not: 'archived' } },
      select: {
        id: true,
        name: true,
        client: {
          select: { firstName: true, lastName: true, company: true },
        },
      },
      orderBy: { name: 'asc' },
    });
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      clientName: formatClientName(p.client),
    }));
  }

  async upsertEntry(dto: UpsertWeeklyEntryDto, userId?: string) {
    const [week, project, existing] = await Promise.all([
      this.prisma.fiscalWeek.findUnique({ where: { id: dto.fiscalWeekId } }),
      this.prisma.project.findUnique({ where: { id: dto.projectId } }),
      this.prisma.weeklyEntry.findUnique({
        where: {
          fiscalWeekId_projectId: {
            fiscalWeekId: dto.fiscalWeekId,
            projectId: dto.projectId,
          },
        },
        select: {
          status: true,
          invoiceSentAt: true,
          receivedAt: true,
        },
      }),
    ]);
    if (!week) throw new NotFoundException('Fiscal week not found');
    if (!project) throw new NotFoundException('Project not found');

    // If status is no_work: keep amount null; else amount is optional but must parse.
    const amount =
      dto.status === 'no_work' || !dto.amount
        ? null
        : new Prisma.Decimal(dto.amount);

    // Auto-fill audit dates on first transition to the milestone status.
    // Explicit DTO values always win (allows edit + clear-to-null).
    const dtoTouchedInvoice = 'invoiceSentAt' in dto;
    const dtoTouchedReceived = 'receivedAt' in dto;
    const today = new Date();

    const isTransitionToInvoice =
      dto.status === 'planned_invoice' &&
      existing?.status !== 'planned_invoice';
    const isTransitionToReceived =
      dto.status === 'received' && existing?.status !== 'received';

    const invoiceSentAt = dtoTouchedInvoice
      ? dto.invoiceSentAt
        ? new Date(dto.invoiceSentAt)
        : null
      : isTransitionToInvoice
        ? today
        : (existing?.invoiceSentAt ?? null);

    const receivedAt = dtoTouchedReceived
      ? dto.receivedAt
        ? new Date(dto.receivedAt)
        : null
      : isTransitionToReceived
        ? today
        : (existing?.receivedAt ?? null);

    const entry = await this.prisma.weeklyEntry.upsert({
      where: {
        fiscalWeekId_projectId: {
          fiscalWeekId: dto.fiscalWeekId,
          projectId: dto.projectId,
        },
      },
      update: {
        status: dto.status,
        amount,
        note: dto.note ?? null,
        invoiceSentAt,
        receivedAt,
        updatedById: userId ?? null,
      },
      create: {
        fiscalWeekId: dto.fiscalWeekId,
        projectId: dto.projectId,
        status: dto.status,
        amount,
        note: dto.note ?? null,
        invoiceSentAt,
        receivedAt,
        updatedById: userId ?? null,
      },
    });

    return {
      id: entry.id,
      fiscalWeekId: entry.fiscalWeekId,
      projectId: entry.projectId,
      status: entry.status,
      amount: entry.amount ? entry.amount.toString() : null,
      note: entry.note,
      invoiceSentAt: entry.invoiceSentAt
        ? entry.invoiceSentAt.toISOString().slice(0, 10)
        : null,
      receivedAt: entry.receivedAt
        ? entry.receivedAt.toISOString().slice(0, 10)
        : null,
      updatedAt: entry.updatedAt.toISOString(),
    };
  }

  async deleteEntry(id: string) {
    const entry = await this.prisma.weeklyEntry.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Entry not found');
    await this.prisma.weeklyEntry.delete({ where: { id } });
    return { ok: true };
  }

  private computeKpi(
    entries: Array<{ amount: Prisma.Decimal | null; status: PaymentStatus }>,
  ) {
    const buckets: Record<PaymentStatus, { count: number; total: string }> = {
      received: { count: 0, total: '0' },
      in_transit: { count: 0, total: '0' },
      expected_this_month: { count: 0, total: '0' },
      expected_later: { count: 0, total: '0' },
      planned_invoice: { count: 0, total: '0' },
      no_work: { count: 0, total: '0' },
    };
    const totals: Record<PaymentStatus, Prisma.Decimal> = {
      received: new Prisma.Decimal(0),
      in_transit: new Prisma.Decimal(0),
      expected_this_month: new Prisma.Decimal(0),
      expected_later: new Prisma.Decimal(0),
      planned_invoice: new Prisma.Decimal(0),
      no_work: new Prisma.Decimal(0),
    };
    let grand = new Prisma.Decimal(0);
    for (const e of entries) {
      buckets[e.status].count += 1;
      if (e.amount) {
        totals[e.status] = totals[e.status].add(e.amount);
        if (INCOME_STATUSES.includes(e.status)) grand = grand.add(e.amount);
      }
    }
    for (const k of STATUS_ORDER) {
      buckets[k].total = totals[k].toFixed(2);
    }
    return {
      byStatus: buckets,
      total: grand.toFixed(2),
    };
  }

  private async getEffectiveRulesForProjects(
    projectIds: string[],
    asOf: Date,
  ) {
    if (projectIds.length === 0) return new Map();
    const rules = await this.prisma.projectPaymentRule.findMany({
      where: {
        projectId: { in: projectIds },
        effectiveFrom: { lte: asOf },
      },
      orderBy: [{ projectId: 'asc' }, { effectiveFrom: 'desc' }],
    });
    const map = new Map<string, (typeof rules)[number]>();
    for (const r of rules) {
      if (!map.has(r.projectId)) map.set(r.projectId, r);
    }
    return map;
  }

  private computePredictions(
    entries: Array<{
      projectId: string;
      amount: Prisma.Decimal | null;
      status: PaymentStatus;
      updatedAt: Date;
      fiscalWeekId: string;
    }>,
    weeks: Array<{
      id: string;
      endDate: Date;
      startDate: Date;
      indexInMonth: number;
    }>,
    rules: Map<
      string,
      {
        type: PaymentRuleType;
        delayDays: number | null;
        dayOfWeek: number | null;
        intervalWeeks: number | null;
      }
    >,
    monthEnd: Date,
  ) {
    const weekById = new Map(weeks.map((w) => [w.id, w]));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const events: Array<{
      date: Date;
      projectId: string;
      amount: Prisma.Decimal;
      status: PaymentStatus;
    }> = [];

    for (const e of entries) {
      if (!e.amount || e.amount.equals(0)) continue;
      if (e.status === 'no_work') continue;
      if (e.status === 'received') {
        // Already arrived — bucket = today (or updatedAt for grouping)
        events.push({
          date: this.dateOnly(e.updatedAt),
          projectId: e.projectId,
          amount: e.amount,
          status: e.status,
        });
        continue;
      }
      const rule = rules.get(e.projectId);
      const week = weekById.get(e.fiscalWeekId);
      const referenceDate = week?.endDate ?? monthEnd;

      let arrival: Date;
      if (e.status === 'in_transit') {
        const delay = rule?.delayDays ?? 3;
        arrival = this.addDays(this.dateOnly(e.updatedAt), delay);
      } else if (e.status === 'expected_this_month') {
        arrival = this.nextPayoutDay(rule, referenceDate, monthEnd, true);
      } else {
        arrival = this.nextPayoutDay(rule, referenceDate, monthEnd, false);
      }
      events.push({
        date: arrival,
        projectId: e.projectId,
        amount: e.amount,
        status: e.status,
      });
    }

    // Sort by date, group.
    events.sort((a, b) => a.date.getTime() - b.date.getTime());

    const buckets: Array<{
      date: string;
      total: string;
      count: number;
      projectIds: string[];
      statuses: PaymentStatus[];
    }> = [];
    for (const ev of events) {
      const key = ev.date.toISOString().slice(0, 10);
      let last = buckets[buckets.length - 1];
      if (!last || last.date !== key) {
        last = {
          date: key,
          total: '0',
          count: 0,
          projectIds: [],
          statuses: [],
        };
        buckets.push(last);
      }
      last.count += 1;
      last.total = new Prisma.Decimal(last.total).add(ev.amount).toFixed(2);
      if (!last.projectIds.includes(ev.projectId))
        last.projectIds.push(ev.projectId);
      if (!last.statuses.includes(ev.status)) last.statuses.push(ev.status);
    }

    // Cumulative totals — "к дате X накопится Y"
    let running = new Prisma.Decimal(0);
    const cumulative = buckets.map((b) => {
      running = running.add(b.total);
      return { date: b.date, cumulative: running.toFixed(2) };
    });

    return {
      byDate: buckets,
      cumulative,
    };
  }

  private nextPayoutDay(
    rule:
      | {
          type: PaymentRuleType;
          delayDays: number | null;
          dayOfWeek: number | null;
          intervalWeeks: number | null;
        }
      | undefined,
    reference: Date,
    monthEnd: Date,
    clampToMonth: boolean,
  ): Date {
    const ref = this.dateOnly(reference);
    if (!rule || rule.type === 'CUSTOM') {
      // Default: end of month (or reference + 14 for later buckets)
      const fallback = clampToMonth ? monthEnd : this.addDays(ref, 14);
      return this.dateOnly(fallback);
    }
    if (rule.type === 'FIXED_DELAY') {
      const delay = rule.delayDays ?? 3;
      return this.addDays(ref, delay);
    }
    if (rule.type === 'WEEKLY_ON_DOW') {
      const dow = rule.dayOfWeek ?? 5; // Friday default
      const cur = ref.getUTCDay(); // 0=Sun..6=Sat
      const curIso = cur === 0 ? 7 : cur;
      let delta = dow - curIso;
      if (delta <= 0) delta += 7;
      return this.addDays(ref, delta);
    }
    if (rule.type === 'EVERY_N_WEEKS') {
      const n = rule.intervalWeeks ?? 2;
      return this.addDays(ref, n * 7);
    }
    return ref;
  }

  private dateOnly(d: Date): Date {
    const r = new Date(d);
    r.setUTCHours(0, 0, 0, 0);
    return r;
  }

  private addDays(d: Date, days: number): Date {
    const r = new Date(d);
    r.setUTCDate(r.getUTCDate() + days);
    return r;
  }
}

export interface EntryCell {
  id: string;
  amount: string | null;
  status: PaymentStatus;
  note: string | null;
  invoiceSentAt: string | null;
  receivedAt: string | null;
  updatedAt: string;
}
