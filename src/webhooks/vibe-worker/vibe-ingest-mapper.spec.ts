import { describe, expect, it } from '@jest/globals';
import {
  isVibeJobMatchedPayload,
  mapVibeJobPayload,
  VIBE_SCANNER_LABEL,
} from './vibe-ingest-mapper';

const realPayload = {
  event: 'job.matched',
  filterName: 'All Jobs',
  matchedAt: '2026-10-05T17:11:12.345Z',
  job: {
    id: 'vw_01HZXKABCDE12345',
    url: 'https://www.upwork.com/jobs/~0123456789abcdef',
    type: 'hourly',
    title: 'Senior Node.js backend engineer — NestJS + Prisma',
    description:
      'We are rebuilding our billing engine. Looking for someone with…',
    budget: {
      min: 60,
      max: 90,
      display: null,
      currency: 'USD',
    },
    skills: ['Node.js', 'TypeScript', 'NestJS', 'PostgreSQL'],
    duration: '3-6 months',
    postedAt: '2026-10-05T15:00:00.000Z',
    questions: [],
    categories: ['Web development'],
    contractType: 'ongoing',
    hoursPerWeek: '30-40',
    experienceLevel: 'expert',
    connectsRequired: 10,
  },
  match: {
    reasoning: 'Great fit — Node.js + Prisma + enterprise billing.',
    scoreQuickWin: 72,
    scoreRedFlags: 12,
    scoreScopeClarity: 85,
    effortEstimateHours: 240,
  },
  client: {
    hires: 42,
    rating: 4.9,
    hireRate: 85.5,
    location: 'United States',
    rankLabel: 'Top rated',
    rankScore: 0.95,
    jobsPosted: 60,
    totalSpent: 125000,
    reviewCount: 38,
    avgHourlyRate: 55,
    paymentVerified: true,
    locationRestriction: null,
  },
};

describe('isVibeJobMatchedPayload', () => {
  it('accepts a real job.matched payload', () => {
    expect(isVibeJobMatchedPayload(realPayload)).toBe(true);
  });
  it('rejects a non-object or array', () => {
    expect(isVibeJobMatchedPayload(null)).toBe(false);
    expect(isVibeJobMatchedPayload('x')).toBe(false);
    expect(isVibeJobMatchedPayload([1, 2])).toBe(false);
  });
  it('rejects an event with a different `event` discriminator', () => {
    expect(isVibeJobMatchedPayload({ ...realPayload, event: 'ping' })).toBe(false);
  });
  it('rejects when job.id is missing or blank', () => {
    expect(
      isVibeJobMatchedPayload({ ...realPayload, job: { ...realPayload.job, id: '' } }),
    ).toBe(false);
    expect(
      isVibeJobMatchedPayload({ ...realPayload, job: { ...realPayload.job, id: 42 } as unknown }),
    ).toBe(false);
  });
});

describe('mapVibeJobPayload — real payload', () => {
  const mapped = mapVibeJobPayload(realPayload)!;

  it('returns a non-null mapped object', () => {
    expect(mapped).not.toBeNull();
  });

  it('maps the DB-visible scalar fields', () => {
    expect(mapped.providerJobId).toBe('vw_01HZXKABCDE12345');
    expect(mapped.title).toBe('Senior Node.js backend engineer — NestJS + Prisma');
    expect(mapped.jobUrl).toBe('https://www.upwork.com/jobs/~0123456789abcdef');
    expect(mapped.scanner).toBe(VIBE_SCANNER_LABEL);
    expect(mapped.location).toBe('United States');
    expect(mapped.totalSpent).toBe(125000);
    expect(mapped.avgRatePaid).toBe(55);
    expect(mapped.hireRate).toBe(85.5);
    expect(mapped.hSkillsKeywords).toEqual(['Node.js', 'TypeScript', 'NestJS', 'PostgreSQL']);
  });

  it('formats the budget range with hourly suffix when display is null', () => {
    expect(mapped.budget).toBe('USD 60–90/hr');
  });

  it('preserves the full raw payload for audit', () => {
    expect(mapped.rawPayload).toEqual(realPayload);
  });

  it('produces a deterministic AI text that references every signal', () => {
    const text = mapped.rawText;
    for (const needle of [
      'Title: Senior Node.js backend engineer',
      'URL: https://www.upwork.com/jobs',
      'Type: hourly',
      'Budget: USD 60–90/hr',
      'Duration: 3-6 months',
      'Hours/week: 30-40',
      'Experience: expert',
      'Contract: ongoing',
      'Connects required: 10',
      'Skills: Node.js, TypeScript, NestJS, PostgreSQL',
      'Categories: Web development',
      'Description:',
      'We are rebuilding',
      'Client:',
      'Location: United States',
      'Payment verified: true',
      'Total spent: 125000',
      'Avg hourly rate: 55',
      'Hires: 42',
      'Hire rate: 85.5',
      'Rating: 4.9',
      'Reviews: 38',
      'Jobs posted: 60',
      'Rank: Top rated',
      'Vibe reasoning:',
      'Great fit',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('is stable across repeated calls (same input → same text)', () => {
    const again = mapVibeJobPayload(realPayload)!;
    expect(again.rawText).toBe(mapped.rawText);
  });
});

describe('mapVibeJobPayload — rejects demo / diagnostic payloads', () => {
  it('returns null for a bare {hello:"world"} ping', () => {
    expect(mapVibeJobPayload({ hello: 'world' })).toBeNull();
  });
  it('returns null when event is missing', () => {
    expect(mapVibeJobPayload({ job: { id: 'x' } })).toBeNull();
  });
  it('returns null when job.id is empty', () => {
    expect(
      mapVibeJobPayload({ event: 'job.matched', job: { id: '', title: 't' } }),
    ).toBeNull();
  });
  it('returns null for an array top level', () => {
    expect(mapVibeJobPayload([realPayload])).toBeNull();
  });
});

describe('mapVibeJobPayload — budget formatting edge cases', () => {
  const base = { ...realPayload };
  const withBudget = (budget: unknown): typeof base =>
    ({ ...base, job: { ...base.job, budget } }) as typeof base;

  it('prefers display when present', () => {
    expect(mapVibeJobPayload(withBudget({ display: 'USD 50/hr', currency: 'USD' }))!.budget).toBe(
      'USD 50/hr',
    );
  });
  it('falls back to single min for fixed-price', () => {
    const r = mapVibeJobPayload({
      ...base,
      job: { ...base.job, type: 'fixed', budget: { min: 500, currency: 'USD' } },
    });
    expect(r!.budget).toBe('USD 500');
  });
  it('returns null when budget object is empty', () => {
    expect(mapVibeJobPayload(withBudget({}))!.budget).toBeNull();
  });
  it('returns null when budget is not an object', () => {
    expect(mapVibeJobPayload(withBudget(null))!.budget).toBeNull();
  });
});
