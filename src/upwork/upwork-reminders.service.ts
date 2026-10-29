import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { UPWORK_REMINDER_RULES } from './upwork.constants';

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
   *  from change-log + snapshot + reference-data freshness. No
   *  persisted "reminders" table; thresholds live in
   *  upwork.constants.ts. */
  async forProfile(profileId: string): Promise<UpworkReminder[]> {
    const profile = await this.prisma.upworkProfile.findUnique({
      where: { id: profileId },
    });
    if (!profile) throw new NotFoundException('profile not found');

    const now = Date.now();
    const reminders: UpworkReminder[] = [];

    for (const rule of UPWORK_REMINDER_RULES) {
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
      } else if (rule.refCategories) {
        for (const cat of rule.refCategories) {
          const latest = await this.prisma.upworkReferenceData.findFirst({
            where: {
              category: cat,
              active: true,
              OR: [{ profileId }, { profileId: null }],
            },
            orderBy: { collectedDate: 'desc' },
            select: { collectedDate: true },
          });
          if (this.isStale(latest?.collectedDate ?? null, rule.days, now)) {
            reminders.push({
              key: `${rule.key}:${cat}`,
              label: `${rule.label}: ${cat}`,
              severity: 'info',
              days: rule.days,
              context: cat,
            });
          }
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
}
