import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { PayrollService } from '../payroll/payroll.service';

const { Decimal } = Prisma;

@Injectable()
export class CompensationAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payroll: PayrollService,
  ) {}

  async overview(year: number, month: number) {
    const [summary, series, breakdown, upcoming, increases, historyRaw] =
      await Promise.all([
        this.payroll.summary(year, month),
        this.payroll.monthlySeries(...this.startOfWindow(year, month, 12), 12),
        this.payroll.employeeBreakdown(year, month),
        this.upcomingReviews(),
        this.biggestIncreases(),
        this.recentHistory(),
      ]);

    return {
      year,
      month,
      summary,
      monthlySeries: series,
      employeeBreakdown: breakdown,
      upcomingReviews: upcoming,
      biggestIncreases: increases,
      recentHistory: historyRaw,
    };
  }

  private startOfWindow(
    year: number,
    month: number,
    monthsBack: number,
  ): [number, number] {
    let y = year;
    let m = month - (monthsBack - 1);
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    return [y, m];
  }

  private async upcomingReviews() {
    const today = this.today();
    const rows = await this.prisma.salaryReview.findMany({
      where: {
        result: null,
        scheduledDate: { gte: today },
      },
      orderBy: [{ scheduledDate: 'asc' }],
      take: 8,
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            positions: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      employee: r.employee,
      scheduledDate: this.iso(r.scheduledDate),
      previousRateType: r.previousRateType,
      previousRate: r.previousRate ? r.previousRate.toFixed(2) : null,
      note: r.note,
    }));
  }

  private async biggestIncreases() {
    const rows = await this.prisma.salaryReview.findMany({
      where: {
        result: 'INCREASED',
        previousRate: { not: null },
        newRate: { not: null },
      },
      orderBy: [{ effectiveDate: 'desc' }],
      take: 20,
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            positions: true,
          },
        },
      },
    });
    const withPct = rows
      .filter((r) => r.previousRate && r.newRate && !r.previousRate.isZero())
      .map((r) => {
        const prev = new Decimal(r.previousRate!);
        const next = new Decimal(r.newRate!);
        const diff = next.minus(prev);
        const pct = diff.dividedBy(prev).times(100);
        return {
          id: r.id,
          employee: r.employee,
          effectiveDate: r.effectiveDate ? this.iso(r.effectiveDate) : null,
          previousRateType: r.previousRateType,
          previousRate: prev.toFixed(2),
          newRateType: r.newRateType,
          newRate: next.toFixed(2),
          diff: diff.toFixed(2),
          pct: pct.toFixed(1),
          pctNum: pct.toNumber(),
        };
      });
    withPct.sort((a, b) => b.pctNum - a.pctNum);
    return withPct.slice(0, 6).map(({ pctNum: _pctNum, ...rest }) => rest);
  }

  private async recentHistory() {
    const rows = await this.prisma.salaryReview.findMany({
      where: { result: { not: null } },
      orderBy: [{ completedAt: 'desc' }, { scheduledDate: 'desc' }],
      take: 10,
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            positions: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      employee: r.employee,
      result: r.result,
      scheduledDate: this.iso(r.scheduledDate),
      effectiveDate: r.effectiveDate ? this.iso(r.effectiveDate) : null,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      previousRateType: r.previousRateType,
      previousRate: r.previousRate ? r.previousRate.toFixed(2) : null,
      newRateType: r.newRateType,
      newRate: r.newRate ? r.newRate.toFixed(2) : null,
    }));
  }

  private iso(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private today(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
}
