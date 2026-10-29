import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { UPWORK_VPI_WARN_THRESHOLD } from './upwork.constants';

export interface AnalyticsQuery {
  profileId: string;
  from?: string;
  to?: string;
}

export interface WeeklyPoint {
  weekStart: string; // ISO date (Monday)
  views: number;
  invites: number;
  directMessages: number;
}

export interface PositionsWeeklyPoint {
  weekStart: string;
  byReferenceId: Record<string, number>; // latest-in-week position
}

export interface ChangeLogMarker {
  date: string;
  section: string;
  summary: string;
}

export interface AnalyticsResponse {
  profile: { id: string; name: string };
  weekly: WeeklyPoint[];
  positionsWeekly: PositionsWeeklyPoint[];
  titlePhrases: Array<{ id: string; value: string }>;
  changeLogMarkers: ChangeLogMarker[];
  viewsPerInvite4w: {
    value: number | null;
    warn: boolean;
    threshold: number;
    views: number;
    invites: number;
  };
}

@Injectable()
export class UpworkAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(query: AnalyticsQuery): Promise<AnalyticsResponse> {
    const profile = await this.prisma.upworkProfile.findUnique({
      where: { id: query.profileId },
    });
    if (!profile) throw new NotFoundException('profile not found');

    const to = query.to ? new Date(query.to) : new Date();
    const defaultFrom = new Date(to);
    defaultFrom.setDate(defaultFrom.getDate() - 90);
    const from = query.from ? new Date(query.from) : defaultFrom;

    const snapshots = await this.prisma.upworkMetricsSnapshot.findMany({
      where: {
        profileId: profile.id,
        date: { gte: from, lte: to },
      },
      orderBy: { date: 'asc' },
      include: {
        positions: {
          include: {
            referenceData: {
              select: { id: true, value: true, category: true },
            },
          },
        },
      },
    });

    /* Weekly aggregation: Monday-start weeks. views/invites/direct
     * messages are summed within the week; position is the latest
     * value in the week per reference. */
    const weeklyMap = new Map<
      string,
      { views: number; invites: number; directMessages: number }
    >();
    const posWeeklyMap = new Map<
      string,
      Map<string, { date: Date; position: number }>
    >();

    for (const s of snapshots) {
      const wk = this.weekStartIso(s.date);
      const w = weeklyMap.get(wk) ?? {
        views: 0,
        invites: 0,
        directMessages: 0,
      };
      w.views += s.views;
      w.invites += s.invites;
      w.directMessages += s.directMessages;
      weeklyMap.set(wk, w);

      let posW = posWeeklyMap.get(wk);
      if (!posW) {
        posW = new Map();
        posWeeklyMap.set(wk, posW);
      }
      for (const p of s.positions) {
        const prev = posW.get(p.referenceDataId);
        if (!prev || prev.date < s.date) {
          posW.set(p.referenceDataId, { date: s.date, position: p.position });
        }
      }
    }

    const weeks = Array.from(weeklyMap.keys()).sort();
    const weekly: WeeklyPoint[] = weeks.map((wk) => ({
      weekStart: wk,
      ...weeklyMap.get(wk)!,
    }));
    const positionsWeekly: PositionsWeeklyPoint[] = weeks.map((wk) => {
      const inner = posWeeklyMap.get(wk);
      const byReferenceId: Record<string, number> = {};
      if (inner) {
        Array.from(inner.entries()).forEach(([refId, v]) => {
          byReferenceId[refId] = v.position;
        });
      }
      return { weekStart: wk, byReferenceId };
    });

    /* title_phrase entries used anywhere in the window (active + for
     * this profile or shared) — used to label chart series. */
    const titlePhrases = await this.prisma.upworkReferenceData.findMany({
      where: {
        category: 'title_phrase',
        active: true,
        OR: [{ profileId: profile.id }, { profileId: null }],
      },
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { value: 'asc' }],
      select: { id: true, value: true },
    });

    const markerRows = await this.prisma.upworkChangeLog.findMany({
      where: { profileId: profile.id, date: { gte: from, lte: to } },
      orderBy: { date: 'asc' },
      select: { date: true, section: true, summary: true },
    });
    const changeLogMarkers: ChangeLogMarker[] = markerRows.map((m) => ({
      date: m.date.toISOString().slice(0, 10),
      section: m.section,
      summary: m.summary,
    }));

    /* views-per-invite — rolling 4-week window ending at `to`. */
    const vpiFrom = new Date(to);
    vpiFrom.setDate(vpiFrom.getDate() - 28);
    const vpiAgg = await this.prisma.upworkMetricsSnapshot.aggregate({
      where: {
        profileId: profile.id,
        date: { gte: vpiFrom, lte: to },
      },
      _sum: { views: true, invites: true },
    });
    const vpiViews = vpiAgg._sum.views ?? 0;
    const vpiInvites = vpiAgg._sum.invites ?? 0;
    const vpiValue = vpiInvites > 0 ? vpiViews / vpiInvites : null;

    return {
      profile: { id: profile.id, name: profile.name },
      weekly,
      positionsWeekly,
      titlePhrases,
      changeLogMarkers,
      viewsPerInvite4w: {
        value: vpiValue,
        warn: vpiValue !== null && vpiValue > UPWORK_VPI_WARN_THRESHOLD,
        threshold: UPWORK_VPI_WARN_THRESHOLD,
        views: vpiViews,
        invites: vpiInvites,
      },
    };
  }

  /** Monday of the week containing `date`, as ISO yyyy-mm-dd. */
  private weekStartIso(date: Date): string {
    const d = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const dow = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
    const diff = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }
}
