/**
 * Keyset neighbor spec for `JobPostService.findNeighbor`.
 *
 * Verifies that Prev / Next walk the full filter+sort stream
 * without using offset pagination, so a row disappearing from the
 * current filter (e.g. after `markViewed` under an Unviewed
 * filter) can neither bounce the user back to the current id nor
 * cause an offset shift to skip the next one.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { JobPostService } from './job-post.service';
import { JobPostQueueService } from './job-post-queue.service';
import { JobPostSortBy, JobPostSortDirection } from './dto/list-job-posts.dto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

const prisma = new PrismaClient();
const settingsService = new SettingsService(prisma as unknown as PrismaService);
const queueStub = {
  enqueue: async () => undefined,
  forgetJob: async () => undefined,
  pause: async () => undefined,
  resume: async () => undefined,
  reconcilePauseState: async () => undefined,
  queueCounts: async () => ({
    waiting: 0,
    delayed: 0,
    active: 0,
    paused: 0,
    prioritized: 0,
  }),
} as unknown as JobPostQueueService;
const svc = new JobPostService(
  prisma as unknown as PrismaService,
  settingsService,
  queueStub,
  {
    emitWebhookReceived: () => undefined,
    emitJobPostChanged: () => undefined,
    emitSettingsScanner: () => undefined,
    emitDiscordDelivered: () => undefined,
    stream$: () => ({}),
  } as never,
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
const TAG = `nav-${randomUUID().slice(0, 8)}`;
let USER_ID = '';
const createdIds: string[] = [];

async function seed(
  order: number,
  overrides: {
    matchScore?: number | null;
    createdAt?: Date;
  } = {},
): Promise<string> {
  // The TAG goes into the title so neighbor queries can scope to
  // this test's seeded posts via the `search` filter, insulating
  // us from any other PROCESSED rows the shared local DB happens
  // to carry.
  const row = await prisma.jobPost.create({
    data: {
      providerJobId: `${TAG}_${order}_${Date.now()}_${Math.random()}`,
      title: `${TAG} post ${order}`,
      rawText: 'x',
      rawPayload: {} as never,
      status: 'PROCESSED',
      scanner: 'vibe-worker',
      hSkillsKeywords: [],
      createdAt: overrides.createdAt ?? new Date(Date.now() - (100 - order) * 1000),
      matchScore:
        overrides.matchScore === undefined ? null : overrides.matchScore,
    },
    select: { id: true },
  });
  createdIds.push(row.id);
  return row.id;
}

async function markViewed(jobPostId: string): Promise<void> {
  await prisma.jobPostView.create({
    data: { jobPostId, userId: USER_ID },
  });
}

afterEach(async () => {
  if (createdIds.length) {
    await prisma.jobPostView
      .deleteMany({ where: { jobPostId: { in: createdIds } } })
      .catch(() => undefined);
    await prisma.jobPost
      .deleteMany({ where: { id: { in: createdIds } } })
      .catch(() => undefined);
    createdIds.length = 0;
  }
});

beforeAll(async () => {
  // JobPostView.userId is FK → User. Reuse any existing user from
  // the local seed data (fast, no extra side effects); if the DB
  // happens to be empty, create a throwaway one for this test.
  const existing = await prisma.user.findFirst({ select: { id: true } });
  if (!existing) {
    throw new Error(
      'neighbor.spec requires at least one User row in the local DB',
    );
  }
  USER_ID = existing.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('findNeighbor — keyset Prev/Next', () => {
  it('next and prev traverse createdAt desc order and never return the current id', async () => {
    const [a, b, c] = [await seed(0), await seed(1), await seed(2)];
    const scope = { status: 'PROCESSED' as const, search: TAG };
    // createdAt desc order: c → b → a (c is newest, a is oldest).
    // Next from c should be b; next from b should be a; next from
    // a should be null. Scoped to TAG so other PROCESSED rows in
    // the shared local DB can't be returned as "the next one".
    expect((await svc.findNeighbor(c, USER_ID, 'next', scope)).id).toBe(b);
    expect((await svc.findNeighbor(b, USER_ID, 'next', scope)).id).toBe(a);
    expect((await svc.findNeighbor(a, USER_ID, 'next', scope)).id).toBeNull();
    expect((await svc.findNeighbor(a, USER_ID, 'prev', scope)).id).toBe(b);
    expect((await svc.findNeighbor(b, USER_ID, 'prev', scope)).id).toBe(c);
    expect((await svc.findNeighbor(c, USER_ID, 'prev', scope)).id).toBeNull();
  });

  it('under the Unviewed filter: current post is excluded even if just viewed, and no post is skipped across a logical page boundary', async () => {
    // Seed a long enough chain so we cover > 1 page's worth under
    // the Unviewed filter (even though keyset doesn't actually use
    // pages — this models the user flow that would otherwise skip).
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seed(i));
    // Chronological order from newest to oldest (list order):
    //   ids[4] (newest) → ids[3] → ids[2] → ids[1] → ids[0]
    const chain = [...ids].reverse();

    // Walk via Next with Unviewed filter, marking each post as
    // viewed just as the detail page would.
    const walked: string[] = []; let cur: string | null = chain[0];
    while (cur) {
      walked.push(cur);
      await markViewed(cur);
      const n = await svc.findNeighbor(cur, USER_ID, 'next', {
        status: 'PROCESSED',
        viewed: 'unviewed',
        search: TAG,
      });
      cur = n.id;
    }
    // Every post must be visited exactly once, in order; no skips,
    // no duplicates, no bouncing back to the already-viewed post.
    expect(walked).toEqual(chain);
  });

  it('honours sortBy=matchScore desc with id-asc tie-breaker', async () => {
    // Two posts share score 80 → tie-breaker by id ascending.
    // Posts: a=90, b=80 (id-smaller), c=80 (id-larger), d=60.
    // Score desc order: a → (b, c in id-asc) → d. Walking next
    // from each gives exactly the next one.
    const a = await seed(0, { matchScore: 90 });
    const b = await seed(1, { matchScore: 80 });
    const c = await seed(2, { matchScore: 80 });
    const d = await seed(3, { matchScore: 60 });

    const scope = {
      status: 'PROCESSED' as const,
      sortBy: JobPostSortBy.matchScore,
      sortDirection: JobPostSortDirection.desc,
      search: TAG,
    };

    // Figure out the id order for the two tied rows (Postgres
    // uuid v4 → unpredictable); the keyset tie-breaker is `id asc`,
    // so lexicographically smaller id comes first in the next-walk.
    const [tieFirst, tieSecond] = [b, c].sort();

    expect((await svc.findNeighbor(a, USER_ID, 'next', scope)).id).toBe(
      tieFirst,
    );
    expect((await svc.findNeighbor(tieFirst, USER_ID, 'next', scope)).id).toBe(
      tieSecond,
    );
    expect((await svc.findNeighbor(tieSecond, USER_ID, 'next', scope)).id).toBe(
      d,
    );
    expect((await svc.findNeighbor(d, USER_ID, 'next', scope)).id).toBeNull();

    // Prev reverses.
    expect((await svc.findNeighbor(d, USER_ID, 'prev', scope)).id).toBe(
      tieSecond,
    );
    expect((await svc.findNeighbor(tieSecond, USER_ID, 'prev', scope)).id).toBe(
      tieFirst,
    );
    expect((await svc.findNeighbor(tieFirst, USER_ID, 'prev', scope)).id).toBe(
      a,
    );
    expect((await svc.findNeighbor(a, USER_ID, 'prev', scope)).id).toBeNull();
  });

  it('sortBy=matchScore asc traverses in ascending order', async () => {
    const a = await seed(0, { matchScore: 10 });
    const b = await seed(1, { matchScore: 50 });
    const c = await seed(2, { matchScore: 90 });

    const scope = {
      status: 'PROCESSED' as const,
      sortBy: JobPostSortBy.matchScore,
      sortDirection: JobPostSortDirection.asc,
      search: TAG,
    };

    expect((await svc.findNeighbor(a, USER_ID, 'next', scope)).id).toBe(b);
    expect((await svc.findNeighbor(b, USER_ID, 'next', scope)).id).toBe(c);
    expect((await svc.findNeighbor(c, USER_ID, 'next', scope)).id).toBeNull();
    expect((await svc.findNeighbor(a, USER_ID, 'prev', scope)).id).toBeNull();
  });

  it('sortBy on a nullable column keeps NULL rows in the walk (NULLS LAST)', async () => {
    // Seeded in createdAt order: nullOne (oldest), scored, nullTwo (newest).
    // Score-desc list order with NULLS LAST:
    //   scored (70) → nulls, ordered by id ASC among them.
    // Figure out the id ordering of the two null rows so the
    // assertions don't depend on uuid luck.
    const nullOne = await seed(0, { matchScore: null });
    const scored = await seed(1, { matchScore: 70 });
    const nullTwo = await seed(2, { matchScore: null });
    const [firstNull, secondNull] = [nullOne, nullTwo].sort();

    const scope = {
      status: 'PROCESSED' as const,
      sortBy: JobPostSortBy.matchScore,
      sortDirection: JobPostSortDirection.desc,
      search: TAG,
    };

    // From the only scored post, next crosses into the null tail
    // (sorted by id ASC). It must NOT return null and skip them.
    expect(
      (await svc.findNeighbor(scored, USER_ID, 'next', scope)).id,
    ).toBe(firstNull);
    // Prev from scored: scored is the first non-null, nothing is
    // before it in the list → null.
    expect(
      (await svc.findNeighbor(scored, USER_ID, 'prev', scope)).id,
    ).toBeNull();

    // Walk through the null tail by id ASC.
    expect(
      (await svc.findNeighbor(firstNull, USER_ID, 'next', scope)).id,
    ).toBe(secondNull);
    // From the last null, there's nothing more.
    expect(
      (await svc.findNeighbor(secondNull, USER_ID, 'next', scope)).id,
    ).toBeNull();

    // Reverse walk crosses the boundary too.
    expect(
      (await svc.findNeighbor(secondNull, USER_ID, 'prev', scope)).id,
    ).toBe(firstNull);
    // Prev from the first null walks back into the non-null section.
    expect(
      (await svc.findNeighbor(firstNull, USER_ID, 'prev', scope)).id,
    ).toBe(scored);
  });

  it('two NULL-score rows walk by id ASC and the current id is never returned', async () => {
    const n1 = await seed(0, { matchScore: null });
    const n2 = await seed(1, { matchScore: null });
    const n3 = await seed(2, { matchScore: null });
    const sorted = [n1, n2, n3].sort();

    const scope = {
      status: 'PROCESSED' as const,
      sortBy: JobPostSortBy.matchScore,
      sortDirection: JobPostSortDirection.desc,
      search: TAG,
    };

    expect((await svc.findNeighbor(sorted[0], USER_ID, 'next', scope)).id).toBe(
      sorted[1],
    );
    expect((await svc.findNeighbor(sorted[1], USER_ID, 'next', scope)).id).toBe(
      sorted[2],
    );
    expect((await svc.findNeighbor(sorted[2], USER_ID, 'next', scope)).id).toBeNull();

    expect((await svc.findNeighbor(sorted[2], USER_ID, 'prev', scope)).id).toBe(
      sorted[1],
    );
    expect((await svc.findNeighbor(sorted[1], USER_ID, 'prev', scope)).id).toBe(
      sorted[0],
    );
    expect((await svc.findNeighbor(sorted[0], USER_ID, 'prev', scope)).id).toBeNull();
  });

  it('Prev crosses the viewed/unviewed boundary without pointing back to the viewed current id', async () => {
    const [a, b] = [await seed(0), await seed(1)];
    await markViewed(b);
    const prev = await svc.findNeighbor(a, USER_ID, 'prev', {
      status: 'PROCESSED',
      viewed: 'unviewed',
      search: TAG,
    });
    expect(prev.id).toBeNull();
    const prevAll = await svc.findNeighbor(a, USER_ID, 'prev', {
      status: 'PROCESSED',
      search: TAG,
    });
    expect(prevAll.id).toBe(b);
  });
});
