import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { UPWORK_REMINDER_RULES_BY_TIER } from './upwork.constants';

export interface UpworkReminder {
  key: string;
  label: string;
  severity: 'info' | 'warn';
  days: number;
  context?: string;
}

@Injectable()
export class UpworkRemindersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns reminders for the given profile — computed on the fly
   *  from change-log + snapshot freshness. No persisted "reminders"
   *  table; thresholds live in upwork.constants.ts. */
  async forProfile(profileId: string): Promise<UpworkReminder[]> {
    const profile = await this.prisma.upworkProfile.findUnique({
      where: { id: profileId },
    });
    if (!profile) throw new NotFoundException('profile not found');

    const now = Date.now();
    const reminders: UpworkReminder[] = [];
    const rules = UPWORK_REMINDER_RULES_BY_TIER[profile.tier];

    for (const rule of rules) {
      if (rule.section) {
        const latest = await this.prisma.upworkChangeLog.findFirst({
          where: { profileId, section: rule.section },
          orderBy: { date: 'desc' },
          select: { date: true },
        });
        if (this.isStale(latest?.date ?? null, rule.days, now)) {
          reminders.push({
            key: rule.key,
            label: rule.label,
            severity: 'warn',
            days: rule.days,
          });
        }
      } else if (rule.sections && rule.sections.length) {
        /* ANY of these sections keeps the reminder green — a single
         * fresh entry in portfolio OR skills OR title is enough.
         * Used by the "Daily update" rule and the secondary
         * "review the profile" rule. */
        const latest = await this.prisma.upworkChangeLog.findFirst({
          where: { profileId, section: { in: rule.sections } },
          orderBy: { date: 'desc' },
          select: { date: true },
        });
        if (this.isStale(latest?.date ?? null, rule.days, now)) {
          reminders.push({
            key: rule.key,
            label: rule.label,
            severity: 'warn',
            days: rule.days,
          });
        }
      } else if (rule.kind === 'snapshot') {
        const latest = await this.prisma.upworkMetricsSnapshot.findFirst({
          where: { profileId },
          orderBy: { date: 'desc' },
          select: { date: true },
        });
        if (this.isStale(latest?.date ?? null, rule.days, now)) {
          reminders.push({
            key: rule.key,
            label: rule.label,
            severity: 'warn',
            days: rule.days,
          });
        }
      }
    }

    return reminders;
  }

  private isStale(date: Date | null, days: number, now: number): boolean {
    if (!date) return true;
    const diffDays = (now - date.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays > days;
  }

  /** Aggregate across all active profiles. Returns the number of
   *  profiles with at least one lit reminder plus the total count
   *  of lit reminders. Used by the attention panel. */
  async summary(): Promise<{
    profiles: number;
    totalReminders: number;
  }> {
    const active = await this.prisma.upworkProfile.findMany({
      where: { active: true },
      select: { id: true },
    });
    let profiles = 0;
    let totalReminders = 0;
    for (const p of active) {
      const list = await this.forProfile(p.id);
      if (list.length > 0) {
        profiles++;
        totalReminders += list.length;
      }
    }
    return { profiles, totalReminders };
  }
}
