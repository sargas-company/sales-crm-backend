import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  AI_PRICING_VERSION,
  AiUsageTokens,
  estimateUsdCost,
} from '../anthropic/pricing';

export interface RecordAiCallInput {
  model: string;
  operation: string;
  usage: AiUsageTokens;
  latencyMs?: number;
  requestId?: string | null;
  relatedJobPostId?: string | null;
}

export interface AiSpendWindow {
  from: Date;
  to: Date;
}

export interface AiSpendBreakdownRow {
  key: string;
  calls: number;
  usd: number;
}

export interface AiSpendPerDayRow {
  day: string; // YYYY-MM-DD (UTC)
  usd: number;
  calls: number;
}

export interface AiSpendSummary {
  totalUsd: number;
  totalCalls: number;
  totalTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  perModel: AiSpendBreakdownRow[];
  perOperation: AiSpendBreakdownRow[];
  perDay: AiSpendPerDayRow[];
  pricingVersion: string;
}

/**
 * Durable ledger of every Anthropic Messages API call. Writes are
 * fire-and-forget from the caller's point of view: a failed insert
 * is logged but never thrown back — telemetry must not break the
 * AI path. The caller passes raw token counts from the Anthropic
 * `usage` block; the service stamps an `estimatedCostUsd` evaluated
 * against the pinned pricing table at write time.
 */
@Injectable()
export class AiUsageLedgerService {
  private readonly logger = new Logger(AiUsageLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAiCallInput): Promise<void> {
    try {
      const estimatedCostUsd = estimateUsdCost(input.model, input.usage);
      await this.prisma.aiUsageLedger.create({
        data: {
          model: input.model,
          operation: input.operation,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cacheReadInputTokens: input.usage.cacheReadInputTokens,
          cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
          latencyMs: input.latencyMs ?? null,
          requestId: input.requestId ?? null,
          relatedJobPostId: input.relatedJobPostId ?? null,
          estimatedCostUsd,
          pricingVersion: AI_PRICING_VERSION,
        },
      });
    } catch (err) {
      this.logger.warn(
        `AiUsageLedger.record failed (model=${input.model} op=${input.operation}): ${(err as Error).message}`,
      );
    }
  }

  async summarise(window: AiSpendWindow): Promise<AiSpendSummary> {
    const rows = await this.prisma.aiUsageLedger.findMany({
      where: { createdAt: { gte: window.from, lt: window.to } },
      select: {
        createdAt: true,
        model: true,
        operation: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadInputTokens: true,
        cacheCreationInputTokens: true,
        estimatedCostUsd: true,
      },
    });

    const totals = {
      totalUsd: 0,
      totalCalls: rows.length,
      totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const perModelMap = new Map<string, { calls: number; usd: number }>();
    const perOperationMap = new Map<string, { calls: number; usd: number }>();
    const perDayMap = new Map<string, { calls: number; usd: number }>();

    for (const r of rows) {
      const usd = Number(r.estimatedCostUsd);
      totals.totalUsd += usd;
      totals.totalTokens.input += r.inputTokens;
      totals.totalTokens.output += r.outputTokens;
      totals.totalTokens.cacheRead += r.cacheReadInputTokens;
      totals.totalTokens.cacheWrite += r.cacheCreationInputTokens;

      bump(perModelMap, r.model, usd);
      bump(perOperationMap, r.operation, usd);
      const dayKey = r.createdAt.toISOString().slice(0, 10);
      bump(perDayMap, dayKey, usd);
    }

    return {
      totalUsd: round6(totals.totalUsd),
      totalCalls: totals.totalCalls,
      totalTokens: totals.totalTokens,
      perModel: toRows(perModelMap).sort((a, b) => b.usd - a.usd),
      perOperation: toRows(perOperationMap).sort((a, b) => b.usd - a.usd),
      perDay: Array.from(perDayMap.entries())
        .map(([day, v]) => ({ day, usd: round6(v.usd), calls: v.calls }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      pricingVersion: AI_PRICING_VERSION,
    };
  }
}

function bump(
  map: Map<string, { calls: number; usd: number }>,
  key: string,
  usd: number,
): void {
  const cur = map.get(key) ?? { calls: 0, usd: 0 };
  cur.calls += 1;
  cur.usd += usd;
  map.set(key, cur);
}

function toRows(
  map: Map<string, { calls: number; usd: number }>,
): AiSpendBreakdownRow[] {
  return Array.from(map.entries()).map(([key, v]) => ({
    key,
    calls: v.calls,
    usd: round6(v.usd),
  }));
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
