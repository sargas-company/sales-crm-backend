import { Injectable } from '@nestjs/common';
import { Prisma, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Aggregation = 'week' | 'month';

export interface OverviewFilters {
  from?: string;
  to?: string;
  projectId?: string;
  status?: ProjectStatus;
  aggregation?: Aggregation;
}

const STATUSES: ProjectStatus[] = [
  'planned',
  'active',
  'paused',
  'completed',
  'archived',
];

@Injectable()
export class ProjectAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(f: OverviewFilters) {
    const aggregation: Aggregation = f.aggregation ?? 'week';
    const fromDate = f.from ? new Date(f.from) : this.defaultFrom();
    const toDate = f.to ? new Date(f.to) : new Date();
    fromDate.setUTCHours(0, 0, 0, 0);
    toDate.setUTCHours(23, 59, 59, 999);

    // ── Base queries ─────────────────────────────────────────────
    const projectWhere: Prisma.ProjectWhereInput = {
      ...(f.projectId ? { id: f.projectId } : {}),
      ...(f.status ? { status: f.status } : {}),
    };

    const projects = await this.prisma.project.findMany({
      where: projectWhere,
      select: { id: true, name: true, status: true, createdAt: true },
      orderBy: { name: 'asc' },
    });
    const projectIds = projects.map((p) => p.id);
    const projectMap = new Map(projects.map((p) => [p.id, p]));

    // Filter reports by the range AND by the project scope (if any).
    const reportWhere: Prisma.ProjectReportWhereInput = {
      reportDate: { gte: fromDate, lte: toDate },
      ...(projectIds.length ? { projectId: { in: projectIds } } : {}),
    };
    const reports = await this.prisma.projectReport.findMany({
      where: reportWhere,
      select: {
        id: true,
        projectId: true,
        employeeId: true,
        reportDate: true,
        hours: true,
      },
      orderBy: { reportDate: 'asc' },
    });

    // ── Time-series buckets ─────────────────────────────────────
    const buckets = this.buildBuckets(fromDate, toDate, aggregation);
    const [kpi, statusOverTime] = await Promise.all([
      this.kpi(projects, reports, projectIds, f),
      this.statusOverTime(buckets, f),
    ]);
    const hoursSeries = this.hoursSeries(reports, projects, buckets);
    const reportsSeries = this.reportsSeries(reports, buckets);

    // ── Workload table ─────────────────────────────────────────
    const workload = this.workload(projects, reports);

    return {
      range: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        aggregation,
      },
      statuses: STATUSES,
      kpi,
      hoursSeries,
      reportsSeries,
      statusOverTime,
      workload,
    };
  }

  private async kpi(
    projects: Array<{ id: string; status: string }>,
    reports: Array<{ employeeId: string | null; hours: number }>,
    _projectIds: string[],
    f: OverviewFilters,
  ) {
    // Status counts across the current scope (respect filters).
    const active = projects.filter((p) => p.status === 'active').length;
    const paused = projects.filter((p) => p.status === 'paused').length;
    const archived = projects.filter((p) => p.status === 'archived').length;

    // Reports + hours + report-authors within the range/scope. Report
    // authors only counts Employee-authored (MANUAL) rows — the
    // Discord flow has no Employee identity, so including those would
    // conflate "people filing reports" with "channels that posted".
    // Team size per project lives in `assignedToActive` below.
    const reportsCount = reports.length;
    let trackedHours = 0;
    const reportAuthors = new Set<string>();
    for (const r of reports) {
      trackedHours += r.hours;
      if (r.employeeId) reportAuthors.add(r.employeeId);
    }

    // "Current employees assigned to active projects" — assignments now,
    // not historical. Respects the same project scope so the number
    // matches what the user sees on the filtered page.
    const activeAssignments = await this.prisma.projectMember.findMany({
      where: {
        project: {
          status: 'active',
          ...(f.projectId ? { id: f.projectId } : {}),
        },
      },
      select: { employeeId: true },
    });
    const assignedToActive = new Set(
      activeAssignments.map((a) => a.employeeId),
    ).size;

    return {
      active,
      paused,
      archived,
      reportsCount,
      trackedHours: Number(trackedHours.toFixed(2)),
      reportAuthors: reportAuthors.size,
      assignedToActive,
    };
  }

  private buildBuckets(from: Date, to: Date, aggregation: Aggregation) {
    const buckets: Array<{ start: Date; end: Date; label: string }> = [];
    const cursor = this.floor(from, aggregation);
    while (cursor <= to) {
      const end = this.next(cursor, aggregation);
      buckets.push({
        start: new Date(cursor),
        end: new Date(Math.min(end.getTime(), to.getTime())),
        label: this.label(cursor, aggregation),
      });
      cursor.setTime(end.getTime());
    }
    return buckets;
  }

  private hoursSeries(
    reports: Array<{ projectId: string; hours: number; reportDate: Date }>,
    projects: Array<{ id: string; name: string }>,
    buckets: Array<{ start: Date; end: Date; label: string }>,
  ) {
    // Precompute per-project totals in each bucket.
    const byBucket: Array<{
      period: string;
      periodStart: string;
      total: number;
      perProject: Record<string, number>;
    }> = buckets.map((b) => ({
      period: b.label,
      periodStart: b.start.toISOString(),
      total: 0,
      perProject: {},
    }));
    for (const r of reports) {
      const idx = buckets.findIndex(
        (b) => r.reportDate >= b.start && r.reportDate < b.end,
      );
      if (idx < 0) continue;
      const bucket = byBucket[idx];
      bucket.total += r.hours;
      bucket.perProject[r.projectId] =
        (bucket.perProject[r.projectId] ?? 0) + r.hours;
    }
    // Round floats for wire.
    for (const b of byBucket) {
      b.total = Number(b.total.toFixed(2));
      for (const k of Object.keys(b.perProject)) {
        b.perProject[k] = Number(b.perProject[k].toFixed(2));
      }
    }
    return {
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      buckets: byBucket,
    };
  }

  private reportsSeries(
    reports: Array<{ hours: number; reportDate: Date }>,
    buckets: Array<{ start: Date; end: Date; label: string }>,
  ) {
    return buckets.map((b) => {
      let count = 0;
      let hours = 0;
      for (const r of reports) {
        if (r.reportDate >= b.start && r.reportDate < b.end) {
          count += 1;
          hours += r.hours;
        }
      }
      return {
        period: b.label,
        periodStart: b.start.toISOString(),
        count,
        hours: Number(hours.toFixed(2)),
      };
    });
  }

  private async statusOverTime(
    buckets: Array<{ start: Date; end: Date; label: string }>,
    f: OverviewFilters,
  ) {
    // For each bucket end, count how many projects had each status
    // according to ProjectStatusHistory. We take the last history row
    // where effectiveAt <= bucket.end. Restrict to the same project
    // scope as the rest of the page.
    const projectWhere: Prisma.ProjectWhereInput = {
      ...(f.projectId ? { id: f.projectId } : {}),
    };
    const projects = await this.prisma.project.findMany({
      where: projectWhere,
      select: { id: true },
    });
    const projectIds = projects.map((p) => p.id);
    if (projectIds.length === 0) {
      return buckets.map((b) => ({
        period: b.label,
        periodStart: b.start.toISOString(),
        statusCounts: this.emptyStatusCounts(),
      }));
    }
    const history = await this.prisma.projectStatusHistory.findMany({
      where: { projectId: { in: projectIds } },
      select: { projectId: true, status: true, effectiveAt: true },
      orderBy: [{ projectId: 'asc' }, { effectiveAt: 'asc' }],
    });

    // Index history by projectId.
    const byProject = new Map<
      string,
      Array<{ status: ProjectStatus; effectiveAt: Date }>
    >();
    for (const h of history) {
      const list = byProject.get(h.projectId) ?? [];
      list.push({ status: h.status, effectiveAt: h.effectiveAt });
      byProject.set(h.projectId, list);
    }

    return buckets.map((b) => {
      const counts = this.emptyStatusCounts();
      for (const pid of projectIds) {
        const list = byProject.get(pid) ?? [];
        // Pick the last row where effectiveAt <= bucket end.
        let last: ProjectStatus | null = null;
        for (const row of list) {
          if (row.effectiveAt <= b.end) last = row.status;
          else break;
        }
        if (last) counts[last] += 1;
      }
      return {
        period: b.label,
        periodStart: b.start.toISOString(),
        statusCounts: counts,
      };
    });
  }

  private workload(
    projects: Array<{ id: string; name: string; status: string }>,
    reports: Array<{
      projectId: string;
      hours: number;
      employeeId: string | null;
      reportDate: Date;
    }>,
  ) {
    let grandTotal = 0;
    for (const r of reports) grandTotal += r.hours;

    // Aggregate per project. `reportAuthors` counts distinct Employee
    // authors of MANUAL rows only — Discord-sourced rows have no
    // Employee identity, so they contribute to `hours` and `reports`
    // but not to the author head-count. Team size is a separate
    // concept, served by ProjectMember assignments where needed.
    const byProject = new Map<
      string,
      {
        id: string;
        name: string;
        status: string;
        hours: number;
        reports: number;
        reportAuthors: Set<string>;
        lastReport: Date | null;
      }
    >();
    for (const p of projects) {
      byProject.set(p.id, {
        id: p.id,
        name: p.name,
        status: p.status,
        hours: 0,
        reports: 0,
        reportAuthors: new Set(),
        lastReport: null,
      });
    }
    for (const r of reports) {
      const b = byProject.get(r.projectId);
      if (!b) continue;
      b.hours += r.hours;
      b.reports += 1;
      if (r.employeeId) b.reportAuthors.add(r.employeeId);
      if (!b.lastReport || r.reportDate > b.lastReport) {
        b.lastReport = r.reportDate;
      }
    }
    return [...byProject.values()]
      .map((b) => ({
        id: b.id,
        name: b.name,
        status: b.status,
        hours: Number(b.hours.toFixed(2)),
        reports: b.reports,
        reportAuthors: b.reportAuthors.size,
        lastReport: b.lastReport
          ? b.lastReport.toISOString().slice(0, 10)
          : null,
        share:
          grandTotal > 0 ? Number(((b.hours / grandTotal) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.hours - a.hours);
  }

  private emptyStatusCounts(): Record<ProjectStatus, number> {
    return {
      planned: 0,
      active: 0,
      paused: 0,
      completed: 0,
      archived: 0,
    };
  }

  private floor(date: Date, aggregation: Aggregation): Date {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    if (aggregation === 'week') {
      // Monday-start ISO week.
      const day = d.getUTCDay(); // 0=Sun..6=Sat
      const diff = day === 0 ? -6 : 1 - day;
      d.setUTCDate(d.getUTCDate() + diff);
    } else {
      d.setUTCDate(1);
    }
    return d;
  }

  private next(date: Date, aggregation: Aggregation): Date {
    const d = new Date(date);
    if (aggregation === 'week') d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    return d;
  }

  private label(date: Date, aggregation: Aggregation): string {
    if (aggregation === 'week') {
      return `W${this.isoWeek(date)} · ${date.getUTCFullYear()}`;
    }
    return date.toLocaleString('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  private isoWeek(date: Date): number {
    const tmp = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  private defaultFrom(): Date {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 3);
    return d;
  }
}
