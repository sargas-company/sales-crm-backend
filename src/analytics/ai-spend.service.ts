import { Injectable } from '@nestjs/common';

import { AiUsageLedgerService } from '../ai-usage-ledger/ai-usage-ledger.service';
import { AnalyticsFiltersDto, SalesDateRangeKey } from './dto/analytics-filters.dto';

const DEFAULT_TIMEZONE = 'Europe/Kyiv';
const DEFAULT_DATE_RANGE: SalesDateRangeKey = '7d';

interface Window {
  from: Date;
  to: Date;
}

/**
 * Dedicated service for the Sales Analytics "AI spend" block. Keeps
 * `AnalyticsService` focused on the JobPost pipeline and lets the
 * ledger evolve independently. The date-window resolver mirrors
 * `AnalyticsService.resolveWindow` so this block's `today / 7d / 30d`
 * windows line up exactly with the rest of the Overview tab.
 */
@Injectable()
export class AiSpendService {
  constructor(private readonly ledger: AiUsageLedgerService) {}

  async getAiSpend(filters: AnalyticsFiltersDto) {
    const now = new Date();
    const timezone = filters.timezone ?? DEFAULT_TIMEZONE;
    const window = this.resolveWindow(filters, now, timezone);
    const summary = await this.ledger.summarise(window);
    return {
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        label: this.periodLabel(filters),
      },
      ...summary,
    };
  }

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
      return {
        from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        to: new Date(now.getTime()),
      };
    }
    if (range === '30d') {
      return {
        from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        to: new Date(now.getTime()),
      };
    }
    return {
      from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      to: new Date(now.getTime()),
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
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(now);
      const get = (type: string) => parts.find((p) => p.type === type)?.value;
      const y = Number(get('year'));
      const m = Number(get('month'));
      const d = Number(get('day'));
      const localMidnightUtcGuess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
      const utcOffsetMs =
        now.getTime() -
        Date.UTC(
          y,
          m - 1,
          d,
          Number(get('hour')),
          Number(get('minute')),
          Number(get('second')),
        );
      return new Date(localMidnightUtcGuess.getTime() + utcOffsetMs);
    } catch {
      const copy = new Date(now);
      copy.setUTCHours(0, 0, 0, 0);
      return copy;
    }
  }
}
