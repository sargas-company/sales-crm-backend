import { describe, it, expect } from '@jest/globals';

import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

// Compact regression tests for the aggregateKpi score-range × threshold
// intersection bug. The service used to overwrite the caller's matchScore
// filter with the qualified/hot threshold, silently ignoring user-selected
// scoreMin / scoreMax. The tests below assert AND semantics via the
// captured where clauses.

interface CountCall {
  where: Record<string, unknown>;
}

interface AggregateCall {
  where: Record<string, unknown>;
}

const makePrisma = (): { prisma: PrismaService; counts: CountCall[]; aggregates: AggregateCall[] } => {
  const counts: CountCall[] = [];
  const aggregates: AggregateCall[] = [];
  const prisma = {
    jobPost: {
      count: async (args: CountCall) => {
        counts.push(args);
        return 0;
      },
      aggregate: async (args: AggregateCall) => {
        aggregates.push(args);
        return { _avg: { matchScore: null } };
      },
    },
  } as unknown as PrismaService;
  return { prisma, counts, aggregates };
};

const withMatchScore = (
  service: AnalyticsService,
  where: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> =>
  // Access the private helper through a typed cast for the test.
  (
    service as unknown as {
      withMatchScoreConstraint: (w: unknown, e: unknown) => Record<string, unknown>;
    }
  ).withMatchScoreConstraint(where, extra);

describe('AnalyticsService.aggregateKpi score-range × threshold', () => {
  it('preserves scoreMin / scoreMax while applying the qualified threshold', async () => {
    const { prisma, counts, aggregates } = makePrisma();
    const service = new AnalyticsService(prisma);

    // Simulate the where produced by buildWhere({ scoreMin: 60, scoreMax: 90 })
    const where = { matchScore: { gte: 60, lte: 90 } };
    await (
      service as unknown as {
        aggregateKpi: (w: unknown) => Promise<unknown>;
      }
    ).aggregateKpi(where);

    // 3 count calls: received, qualified, hot
    expect(counts).toHaveLength(3);
    // received — unchanged where
    expect(counts[0].where).toEqual({ matchScore: { gte: 60, lte: 90 } });
    // qualified — max(60, 50) = 60, lte preserved
    expect(counts[1].where).toEqual({ matchScore: { gte: 60, lte: 90 } });
    // hot — max(60, 75) = 75, lte preserved
    expect(counts[2].where).toEqual({ matchScore: { gte: 75, lte: 90 } });

    // aggregate — avg over matchScore not null, but user range is preserved.
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].where).toEqual({
      matchScore: { gte: 60, lte: 90, not: null },
    });
  });

  it('applies the threshold when the caller has no matchScore filter', async () => {
    const { prisma, counts } = makePrisma();
    const service = new AnalyticsService(prisma);

    await (
      service as unknown as {
        aggregateKpi: (w: unknown) => Promise<unknown>;
      }
    ).aggregateKpi({});

    expect(counts[0].where).toEqual({});
    expect(counts[1].where).toEqual({ matchScore: { gte: 50 } });
    expect(counts[2].where).toEqual({ matchScore: { gte: 75 } });
  });

  it('tightens scoreMax when the user max is below the threshold — produces empty result set instead of ignoring the user range', async () => {
    const { prisma, counts } = makePrisma();
    const service = new AnalyticsService(prisma);

    // User asked for [30, 40] — a range strictly below the hot threshold.
    const where = { matchScore: { gte: 30, lte: 40 } };
    await (
      service as unknown as {
        aggregateKpi: (w: unknown) => Promise<unknown>;
      }
    ).aggregateKpi(where);

    // hot: gte becomes 75, lte stays 40 → 0 rows, which is the correct
    // intersection. The previous bug would have reported all rows >= 75,
    // ignoring the user's lte=40 entirely.
    expect(counts[2].where).toEqual({ matchScore: { gte: 75, lte: 40 } });
  });

  it('preserves other where clauses when composing the threshold', () => {
    const { prisma } = makePrisma();
    const service = new AnalyticsService(prisma);

    const where = {
      matchScore: { gte: 60 },
      createdAt: { gte: new Date('2026-01-01'), lt: new Date('2026-02-01') },
      hSkillsKeywords: { hasSome: ['react'] },
    };
    const merged = withMatchScore(service, where, { gte: 50 });

    expect(merged.createdAt).toBe(where.createdAt);
    expect(merged.hSkillsKeywords).toBe(where.hSkillsKeywords);
    expect(merged.matchScore).toEqual({ gte: 60 });
  });
});
