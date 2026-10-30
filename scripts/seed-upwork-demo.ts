/**
 * Upwork module demo seed — profiles, reference data, change-log
 * entries and metrics snapshots. Idempotent: re-running will not
 * create duplicate profiles (by name) or duplicate reference entries
 * (by profile+category+value), and will replace this profile's
 * snapshots for the covered date range so the chart stays stable.
 *
 * Local-only. Run via:
 *   APP_ENV=local npx ts-node scripts/seed-upwork-demo.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import {
  PrismaClient,
  UpworkChangeLogSection,
  UpworkReferenceCategory,
} from '@prisma/client';

const prisma = new PrismaClient();

/* ─── Fixtures ────────────────────────────────────────────────── */

interface ProfileSpec {
  key: string; // used to look rows up on re-seed
  firstName: string;
  lastName: string | null;
  title: string | null;
  url: string;
  note: string;
  active: boolean;
}

const PROFILES: ProfileSpec[] = [
  {
    key: 'vadym',
    firstName: 'Vadym',
    lastName: 'Chervonchenko',
    title: 'Senior Full-Stack Developer',
    url: 'https://www.upwork.com/freelancers/senior-fullstack-react-node',
    note: 'Primary profile. React 18 / TypeScript / NestJS / Postgres. US and EU time zones.',
    active: true,
  },
  {
    key: 'olha',
    firstName: 'Olha',
    lastName: 'Kovalenko',
    title: 'AI Engineer',
    url: 'https://www.upwork.com/freelancers/ai-llm-engineer',
    note: 'LLM apps, Claude + OpenAI, retrieval, evals.',
    active: true,
  },
  {
    key: 'anna',
    firstName: 'Anna',
    lastName: 'Petrenko',
    title: 'React Native Developer',
    url: 'https://www.upwork.com/freelancers/rn-mobile',
    note: 'React Native + Expo. Lower volume, kept open for referrals.',
    active: true,
  },
  {
    key: 'dmytro',
    firstName: 'Dmytro',
    lastName: 'Sarafaniuk',
    title: 'DevOps Engineer',
    url: 'https://www.upwork.com/freelancers/devops-aws-iac',
    note: 'Archived — reactivate if DevOps leads start arriving.',
    active: false,
  },
];

interface RefSpec {
  profile: string | null; // profile name or null = shared
  category: UpworkReferenceCategory;
  value: string;
  note?: string;
  collectedDaysAgo: number;
  frequency?: number;
  order?: number;
}

const REFERENCES: RefSpec[] = [
  /* ── Primary profile — title phrases + skills + requirements ── */
  { profile: 'Senior Full-Stack Developer', category: 'title_phrase', value: 'senior react developer', collectedDaysAgo: 2, order: 1, frequency: 48 },
  { profile: 'Senior Full-Stack Developer', category: 'title_phrase', value: 'full stack typescript engineer', collectedDaysAgo: 2, order: 2, frequency: 36 },
  { profile: 'Senior Full-Stack Developer', category: 'title_phrase', value: 'nestjs postgres backend', collectedDaysAgo: 2, order: 3, frequency: 22 },
  { profile: 'Senior Full-Stack Developer', category: 'title_phrase', value: 'react native specialist', collectedDaysAgo: 10, order: 4, frequency: 14 },
  { profile: 'Senior Full-Stack Developer', category: 'suggestion', value: 'add Playwright to testing section', collectedDaysAgo: 5 },
  { profile: 'Senior Full-Stack Developer', category: 'suggestion', value: 'mention Supabase explicitly', collectedDaysAgo: 7 },
  { profile: 'Senior Full-Stack Developer', category: 'related_query', value: 'react typescript nestjs', collectedDaysAgo: 3, frequency: 94 },
  { profile: 'Senior Full-Stack Developer', category: 'related_query', value: 'full stack saas builder', collectedDaysAgo: 3, frequency: 71 },
  { profile: 'Senior Full-Stack Developer', category: 'green_skill', value: 'tRPC', collectedDaysAgo: 1 },
  { profile: 'Senior Full-Stack Developer', category: 'green_skill', value: 'Prisma', collectedDaysAgo: 4 },
  { profile: 'Senior Full-Stack Developer', category: 'green_skill', value: 'Tailwind CSS', collectedDaysAgo: 6 },
  { profile: 'Senior Full-Stack Developer', category: 'job_skill', value: 'React', collectedDaysAgo: 20, frequency: 320 },
  { profile: 'Senior Full-Stack Developer', category: 'job_skill', value: 'TypeScript', collectedDaysAgo: 20, frequency: 280 },
  { profile: 'Senior Full-Stack Developer', category: 'job_skill', value: 'Node.js', collectedDaysAgo: 20, frequency: 240 },
  { profile: 'Senior Full-Stack Developer', category: 'job_skill', value: 'PostgreSQL', collectedDaysAgo: 20, frequency: 160 },
  { profile: 'Senior Full-Stack Developer', category: 'client_phrase', value: 'looking for long-term engagement', collectedDaysAgo: 15 },
  { profile: 'Senior Full-Stack Developer', category: 'client_phrase', value: 'need to ship an MVP in 6 weeks', collectedDaysAgo: 15 },
  { profile: 'Senior Full-Stack Developer', category: 'requirement', value: '5+ years React in production', collectedDaysAgo: 25, frequency: 140 },
  { profile: 'Senior Full-Stack Developer', category: 'requirement', value: 'experience with payment integrations', collectedDaysAgo: 25, frequency: 82 },
  { profile: 'Senior Full-Stack Developer', category: 'product_type', value: 'B2B SaaS dashboard', collectedDaysAgo: 30, frequency: 115 },
  { profile: 'Senior Full-Stack Developer', category: 'product_type', value: 'internal tooling', collectedDaysAgo: 30, frequency: 44 },
  { profile: 'Senior Full-Stack Developer', category: 'fact', value: 'Average time-to-first-reply is <2h on this profile.', collectedDaysAgo: 8 },

  /* ── AI profile ── */
  { profile: 'AI Engineer', category: 'title_phrase', value: 'llm applications engineer', collectedDaysAgo: 2, order: 1, frequency: 28 },
  { profile: 'AI Engineer', category: 'title_phrase', value: 'rag pipeline builder', collectedDaysAgo: 2, order: 2, frequency: 18 },
  { profile: 'AI Engineer', category: 'title_phrase', value: 'ai agents developer', collectedDaysAgo: 2, order: 3, frequency: 24 },
  { profile: 'AI Engineer', category: 'suggestion', value: 'add Claude Code SDK case study', collectedDaysAgo: 4 },
  { profile: 'AI Engineer', category: 'green_skill', value: 'LangGraph', collectedDaysAgo: 2 },
  { profile: 'AI Engineer', category: 'green_skill', value: 'pgvector', collectedDaysAgo: 2 },
  { profile: 'AI Engineer', category: 'job_skill', value: 'Python', collectedDaysAgo: 50, frequency: 210 },
  { profile: 'AI Engineer', category: 'job_skill', value: 'LangChain', collectedDaysAgo: 50, frequency: 120 },
  { profile: 'AI Engineer', category: 'client_phrase', value: 'we have proprietary data and need chat on top', collectedDaysAgo: 20 },
  { profile: 'AI Engineer', category: 'requirement', value: 'production LLM deployment experience', collectedDaysAgo: 60, frequency: 92 },
  { profile: 'AI Engineer', category: 'product_type', value: 'internal AI assistant', collectedDaysAgo: 60, frequency: 61 },
  { profile: 'AI Engineer', category: 'fact', value: 'Two of last three contracts started from an invite, not a proposal.', collectedDaysAgo: 11 },

  /* ── Mobile profile ── */
  { profile: 'React Native Developer', category: 'title_phrase', value: 'react native mobile engineer', collectedDaysAgo: 2, order: 1, frequency: 10 },
  { profile: 'React Native Developer', category: 'green_skill', value: 'Expo Router', collectedDaysAgo: 3 },
  { profile: 'React Native Developer', category: 'job_skill', value: 'React Native', collectedDaysAgo: 70, frequency: 95 },

  /* ── Shared references (no profile) ── */
  { profile: null, category: 'client_phrase', value: 'budget flexible for the right person', collectedDaysAgo: 12 },
  { profile: null, category: 'suggestion', value: 'bump the hero image to a 3-second screencast', collectedDaysAgo: 6 },
  { profile: null, category: 'fact', value: 'Clients that start with a Discovery call close at ~40%.', collectedDaysAgo: 25 },
];

interface ChangeLogSpec {
  profile: string;
  daysAgo: number;
  section: UpworkChangeLogSection;
  item?: string;
  summary: string;
  reason?: string;
  before: string;
  after: string;
  references?: Array<{ profile: string | null; value: string }>;
}

const CHANGE_LOG: ChangeLogSpec[] = [
  {
    profile: 'Senior Full-Stack Developer',
    daysAgo: 85,
    section: 'title',
    summary: 'Pivoted the title to React-first phrasing',
    reason: 'Analytics showed React-explicit titles pull 2× the views.',
    before: 'Full-Stack TypeScript Developer | Node.js, React, PostgreSQL',
    after: 'Senior React Developer (TypeScript, Node, PostgreSQL)',
    references: [
      { profile: 'Senior Full-Stack Developer', value: 'senior react developer' },
    ],
  },
  {
    profile: 'Senior Full-Stack Developer',
    daysAgo: 70,
    section: 'overview',
    summary: 'Rewrote overview around outcomes, not stack',
    reason: 'Previous overview led with stack and lost readers.',
    before:
      'I am a full-stack engineer with 7+ years of experience building web applications using React, TypeScript, Node.js, PostgreSQL, Redis, and AWS. I have shipped many projects…',
    after:
      "I ship SaaS products that pay back their cost of development inside the first year. Last engagement: cut a client's weekly ops time from 11 hours to 90 minutes with a focused React + NestJS portal.\n\nStack when it matters: React 18 · TypeScript · NestJS · PostgreSQL · Prisma.",
    references: [
      { profile: 'Senior Full-Stack Developer', value: 'full stack typescript engineer' },
      { profile: 'Senior Full-Stack Developer', value: 'B2B SaaS dashboard' },
    ],
  },
  {
    profile: 'Senior Full-Stack Developer',
    daysAgo: 55,
    section: 'portfolio',
    item: 'Internal CRM for a 40-person services firm',
    summary: 'Added CRM case study with 3-shot before/after screenshots',
    before: '(no portfolio case for this engagement)',
    after:
      'Case: Internal CRM for a 40-person services firm.\nProblem → Approach → Numbers.\nOutcome: 11 h/week → 90 min/week on operations.',
    references: [
      { profile: 'Senior Full-Stack Developer', value: 'B2B SaaS dashboard' },
      { profile: 'Senior Full-Stack Developer', value: 'portfolio of shipped SaaS' },
    ],
  },
  {
    profile: 'Senior Full-Stack Developer',
    daysAgo: 40,
    section: 'skills',
    summary: 'Trimmed skills list from 24 to 12 — kept only strong signals',
    reason: 'Upwork search weights top-10. The long tail was noise.',
    before:
      'React, TypeScript, JavaScript, HTML, CSS, Tailwind, Node.js, NestJS, Express, PostgreSQL, MySQL, MongoDB, Redis, RabbitMQ, Docker, Kubernetes, AWS, GCP, Vercel, Prisma, TypeORM, Jest, Playwright, Cypress',
    after:
      'React · TypeScript · Node.js · NestJS · PostgreSQL · Prisma · Redis · AWS · Playwright · Tailwind · tRPC · Vercel',
    references: [
      { profile: 'Senior Full-Stack Developer', value: 'React' },
      { profile: 'Senior Full-Stack Developer', value: 'TypeScript' },
      { profile: 'Senior Full-Stack Developer', value: 'Node.js' },
    ],
  },
  {
    profile: 'Senior Full-Stack Developer',
    daysAgo: 20,
    section: 'project_catalog',
    item: 'Catalog · MVP in 6 weeks',
    summary: 'Rewrote the weakest catalog (MVP in 6 weeks) around deliverables',
    reason: 'This catalog had the worst invite-to-view ratio of the three.',
    before:
      "I'll build your MVP in 6 weeks using modern tools. Includes planning, design review, implementation, deployment.",
    after:
      'A working MVP, deployed on your domain, in 6 weeks. Fixed scope, fixed price.\n\nWeek 1: concrete spec + Figma.\nWeeks 2–5: ship weekly to staging.\nWeek 6: production + handoff doc.',
    references: [
      { profile: 'Senior Full-Stack Developer', value: 'need to ship an MVP in 6 weeks' },
    ],
  },
  {
    profile: 'Senior Full-Stack Developer',
    daysAgo: 10,
    section: 'portfolio',
    item: 'Patient-flow dashboard for a clinic chain',
    summary: 'Added second portfolio case: healthcare dashboard',
    before: '(single portfolio case present)',
    after:
      'Case: patient-flow dashboard for a 5-location clinic chain.\n6-week delivery, pay-per-location onboarding.\nResult: no-show rate down from 22% to 12% in 90 days.',
    references: [
      { profile: 'Senior Full-Stack Developer', value: 'B2B SaaS dashboard' },
    ],
  },

  {
    profile: 'AI Engineer',
    daysAgo: 60,
    section: 'title',
    summary: 'Opened AI profile with LLM-first phrasing',
    before: '(new profile)',
    after: 'LLM Applications Engineer (RAG, agents, evals)',
    references: [
      { profile: 'AI Engineer', value: 'llm applications engineer' },
    ],
  },
  {
    profile: 'AI Engineer',
    daysAgo: 45,
    section: 'overview',
    summary: 'First AI overview focused on evals and production',
    before: '(empty)',
    after:
      'I build LLM features that make it to production: evals before launch, retries + fallbacks after, cost ceilings baked in. Comfortable with Claude, OpenAI, pgvector, LangGraph.',
    references: [
      { profile: 'AI Engineer', value: 'production LLM deployment experience' },
    ],
  },
  {
    profile: 'AI Engineer',
    daysAgo: 25,
    section: 'portfolio',
    item: 'Internal assistant for a legal-ops team',
    summary: 'Added first AI portfolio case: legal-ops assistant',
    before: '(empty)',
    after:
      'Case: internal assistant for a legal-ops team. 11k documents in pgvector. Evals suite with 42 fixed questions. 94% answer-grounding rate at launch.',
    references: [
      { profile: 'AI Engineer', value: 'internal AI assistant' },
    ],
  },
  {
    profile: 'AI Engineer',
    daysAgo: 6,
    section: 'certificate',
    summary: 'Added Anthropic prompt-engineering certificate',
    before: '(none)',
    after: 'Anthropic — Prompt engineering interactive tutorial · certificate attached.',
  },

  {
    profile: 'React Native Developer',
    daysAgo: 50,
    section: 'title',
    summary: 'Opened Mobile profile with narrow RN focus',
    before: '(new profile)',
    after: 'React Native Mobile Engineer (Expo, TypeScript)',
    references: [
      { profile: 'React Native Developer', value: 'react native mobile engineer' },
    ],
  },
];

/* ─── Snapshot generator ─────────────────────────────────────── */

interface SnapshotProfileSpec {
  profile: string;
  days: number;
  viewsBase: number;
  viewsVar: number;
  invitesBase: number;
  invitesVar: number;
  directMsgsBase: number;
  directMsgsVar: number;
  positionsByPhrase: Array<{ phrase: string; base: number; var: number }>;
}

const SNAPSHOT_SPECS: SnapshotProfileSpec[] = [
  {
    profile: 'Senior Full-Stack Developer',
    days: 180,
    viewsBase: 85,
    viewsVar: 50,
    invitesBase: 7,
    invitesVar: 6,
    directMsgsBase: 4,
    directMsgsVar: 5,
    positionsByPhrase: [
      { phrase: 'senior react developer', base: 18, var: 8 },
      { phrase: 'full stack typescript engineer', base: 24, var: 10 },
      { phrase: 'nestjs postgres backend', base: 12, var: 6 },
      { phrase: 'react native specialist', base: 42, var: 15 },
    ],
  },
  {
    profile: 'AI Engineer',
    days: 120,
    viewsBase: 56,
    viewsVar: 36,
    invitesBase: 5,
    invitesVar: 5,
    directMsgsBase: 3,
    directMsgsVar: 4,
    positionsByPhrase: [
      { phrase: 'llm applications engineer', base: 10, var: 5 },
      { phrase: 'rag pipeline builder', base: 20, var: 8 },
      { phrase: 'ai agents developer', base: 15, var: 7 },
    ],
  },
  {
    profile: 'React Native Developer',
    days: 75,
    viewsBase: 34,
    viewsVar: 24,
    invitesBase: 3,
    invitesVar: 3,
    directMsgsBase: 2,
    directMsgsVar: 3,
    positionsByPhrase: [
      { phrase: 'react native mobile engineer', base: 35, var: 12 },
    ],
  },
];

/** Deterministic pseudo-random in [0, 1) seeded by a string. */
function seededRand(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ─── Main ────────────────────────────────────────────────────── */

async function main() {
  if (process.env.APP_ENV !== 'local') {
    console.error('❌  APP_ENV must be "local" to run this seed. Refusing.');
    process.exit(1);
  }
  console.log('🌱 Upwork demo seed starting…');

  /* 0. Clean up profiles created by earlier revisions of this seed
   * under their old composite names. Prevents duplicates after the
   * rename pass. Two sources of staleness:
   *   (a) earlier seed revisions wrote the composite into `title`;
   *   (b) the split_name migration stuffed it into firstName /
   *       lastName when the old `name` column was dropped, leaving
   *       `title` NULL.
   * We match both. Cascades through reference-data (SET NULL),
   * change-log and snapshots. */
  const OBSOLETE_TITLES = [
    'Senior Full-Stack · React + Node',
    'AI Engineer · LLM / RAG / Agents',
    'Mobile · React Native',
    'DevOps · AWS / IaC (archived)',
  ];
  const OBSOLETE_FIRSTS = ['Senior', 'AI', 'Mobile', 'DevOps'];
  const removed = await prisma.upworkProfile.deleteMany({
    where: {
      OR: [
        { title: { in: OBSOLETE_TITLES } },
        {
          AND: [
            { title: null },
            { firstName: { in: OBSOLETE_FIRSTS } },
            {
              lastName: {
                contains: '·',
              },
            },
          ],
        },
      ],
    },
  });
  if (removed.count) console.log(`• Removed ${removed.count} legacy profile(s).`);

  /* 1. Profiles — upsert by title (which is the user-facing identifier
   * for this seed; all seed references target profiles by title). */
  const profileByName = new Map<string, string>();
  for (const spec of PROFILES) {
    const existing = await prisma.upworkProfile.findFirst({
      where: { title: spec.title ?? undefined },
    });
    const row = existing
      ? await prisma.upworkProfile.update({
          where: { id: existing.id },
          data: {
            firstName: spec.firstName,
            lastName: spec.lastName,
            title: spec.title,
            url: spec.url,
            note: spec.note,
            active: spec.active,
          },
        })
      : await prisma.upworkProfile.create({
          data: {
            firstName: spec.firstName,
            lastName: spec.lastName,
            title: spec.title,
            url: spec.url,
            note: spec.note,
            active: spec.active,
          },
        });
    if (spec.title) profileByName.set(spec.title, row.id);
  }
  console.log(`✓ Profiles: ${profileByName.size}`);

  /* 2. Reference data — upsert by (profileId, category, value). */
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const refByKey = new Map<string, string>(); // key = profile|category|value
  const refKey = (profile: string | null, category: string, value: string) =>
    `${profile ?? '__shared__'}|${category}|${value}`;

  for (const ref of REFERENCES) {
    const profileId = ref.profile ? profileByName.get(ref.profile) ?? null : null;
    const existing = await prisma.upworkReferenceData.findFirst({
      where: { profileId, category: ref.category, value: ref.value },
    });
    const collectedDate = new Date(now - ref.collectedDaysAgo * dayMs);
    const row = existing
      ? await prisma.upworkReferenceData.update({
          where: { id: existing.id },
          data: {
            collectedDate,
            note: ref.note ?? null,
            frequency: ref.frequency ?? null,
            order: ref.order ?? null,
            active: true,
          },
        })
      : await prisma.upworkReferenceData.create({
          data: {
            profileId,
            category: ref.category,
            value: ref.value,
            collectedDate,
            note: ref.note ?? null,
            frequency: ref.frequency ?? null,
            order: ref.order ?? null,
            active: true,
          },
        });
    refByKey.set(refKey(ref.profile, ref.category, ref.value), row.id);
  }
  console.log(`✓ Reference entries: ${refByKey.size}`);

  /* 3. Change-log — remove this seed's demo entries first (identified
   * by summary prefix) so re-running stays idempotent. */
  const seedSummaries = CHANGE_LOG.map((c) => c.summary);
  await prisma.upworkChangeLog.deleteMany({
    where: { summary: { in: seedSummaries } },
  });
  let changeLogN = 0;
  for (const c of CHANGE_LOG) {
    const profileId = profileByName.get(c.profile);
    if (!profileId) continue;
    const refIds = (c.references ?? [])
      .map((r) => refByKey.get(refKey(r.profile, 'placeholder', r.value)))
      .filter(Boolean) as string[];
    /* The map key above used 'placeholder' category — fix: look up
     * by value within the profile across any category. */
    const trueRefIds: string[] = [];
    for (const r of c.references ?? []) {
      const row = await prisma.upworkReferenceData.findFirst({
        where: {
          value: r.value,
          profileId: r.profile ? profileByName.get(r.profile) ?? null : null,
        },
      });
      if (row) trueRefIds.push(row.id);
    }
    void refIds; // keep ref-lookup resilient to collisions
    const date = new Date(now - c.daysAgo * dayMs);
    await prisma.upworkChangeLog.create({
      data: {
        date,
        profileId,
        section: c.section,
        item: c.item ?? null,
        summary: c.summary,
        reason: c.reason ?? null,
        before: c.before,
        after: c.after,
        references: trueRefIds.length
          ? { create: trueRefIds.map((id) => ({ referenceDataId: id })) }
          : undefined,
      },
    });
    changeLogN++;
  }
  console.log(`✓ Change-log entries: ${changeLogN}`);

  /* 4. Metrics snapshots — wipe + regenerate deterministically. */
  let snapN = 0;
  for (const spec of SNAPSHOT_SPECS) {
    const profileId = profileByName.get(spec.profile);
    if (!profileId) continue;

    await prisma.upworkMetricsSnapshot.deleteMany({
      where: { profileId },
    });

    /* Resolve title_phrase referenceDataIds for position rows. */
    const phraseIdByValue = new Map<string, string>();
    for (const p of spec.positionsByPhrase) {
      const row = await prisma.upworkReferenceData.findFirst({
        where: {
          profileId,
          category: 'title_phrase',
          value: p.phrase,
        },
      });
      if (row) phraseIdByValue.set(p.phrase, row.id);
    }

    const rand = seededRand(spec.profile);
    for (let d = spec.days - 1; d >= 0; d--) {
      const date = new Date(now - d * dayMs);
      /* Weekend dip. */
      const dow = date.getUTCDay();
      const weekendMult = dow === 0 || dow === 6 ? 0.65 : 1;
      /* Gradual improvement over time: +X% from start to end. */
      const progress = 1 + (spec.days - d) / spec.days * 0.35;
      const views = Math.max(
        0,
        Math.round(
          (spec.viewsBase + (rand() - 0.5) * spec.viewsVar) * weekendMult * progress,
        ),
      );
      const invites = Math.max(
        0,
        Math.round(
          (spec.invitesBase + (rand() - 0.5) * spec.invitesVar) * weekendMult * progress,
        ),
      );
      const directMessages = Math.max(
        0,
        Math.round(
          (spec.directMsgsBase + (rand() - 0.5) * spec.directMsgsVar) *
            weekendMult *
            progress,
        ),
      );

      const snap = await prisma.upworkMetricsSnapshot.create({
        data: {
          date,
          profileId,
          views,
          invites,
          directMessages,
        },
      });
      snapN++;

      /* Positions: lower over time (improving rank). */
      for (const p of spec.positionsByPhrase) {
        const refId = phraseIdByValue.get(p.phrase);
        if (!refId) continue;
        /* Weekly cadence — only record positions every 2–3 days to
         * mimic manual input. */
        if (d % 3 !== 0) continue;
        const rankDecay = 1 - (spec.days - d) / spec.days * 0.4;
        const pos = Math.max(
          1,
          Math.round((p.base + (rand() - 0.5) * p.var) * rankDecay),
        );
        await prisma.upworkMetricsSnapshotPosition.create({
          data: {
            snapshotId: snap.id,
            referenceDataId: refId,
            position: pos,
          },
        });
      }
    }
  }
  console.log(`✓ Snapshots: ${snapN}`);
  console.log('🌱 done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
