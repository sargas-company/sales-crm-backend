/**
 * Upwork module demo seed — profiles, change-log entries and metrics
 * snapshots (with inline phrases). Idempotent: re-running will not
 * create duplicate profiles (by title) and will replace this
 * profile's snapshots so the chart stays stable.
 *
 * Local-only. Run via:
 *   APP_ENV=local npx tsx scripts/seed-upwork-demo.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient, UpworkChangeLogSection } from '@prisma/client';

const prisma = new PrismaClient();

/* ─── Fixtures ────────────────────────────────────────────────── */

interface ProfileSpec {
  key: string; // used to look rows up on re-seed
  firstName: string;
  lastName: string | null;
  title: string | null;
  tier: 'primary' | 'secondary';
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
    tier: 'primary',
    url: 'https://www.upwork.com/freelancers/senior-fullstack-react-node',
    note: 'Primary profile. React 18 / TypeScript / NestJS / Postgres. US and EU time zones.',
    active: true,
  },
  {
    key: 'olha',
    firstName: 'Olha',
    lastName: 'Kovalenko',
    title: 'AI Engineer',
    tier: 'primary',
    url: 'https://www.upwork.com/freelancers/ai-llm-engineer',
    note: 'LLM apps, Claude + OpenAI, retrieval, evals.',
    active: true,
  },
  {
    key: 'anna',
    firstName: 'Anna',
    lastName: 'Petrenko',
    title: 'React Native Developer',
    tier: 'secondary',
    url: 'https://www.upwork.com/freelancers/rn-mobile',
    note: 'Worker profile. Monthly stats only; rarely re-tuned.',
    active: true,
  },
  {
    key: 'dmytro',
    firstName: 'Dmytro',
    lastName: 'Sarafaniuk',
    title: 'DevOps Engineer',
    tier: 'secondary',
    url: 'https://www.upwork.com/freelancers/devops-aws-iac',
    note: 'Archived — reactivate if DevOps leads start arriving.',
    active: false,
  },
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
  },

  {
    profile: 'AI Engineer',
    daysAgo: 60,
    section: 'title',
    summary: 'Opened AI profile with LLM-first phrasing',
    before: '(new profile)',
    after: 'LLM Applications Engineer (RAG, agents, evals)',
  },
  {
    profile: 'AI Engineer',
    daysAgo: 45,
    section: 'overview',
    summary: 'First AI overview focused on evals and production',
    before: '(empty)',
    after:
      'I build LLM features that make it to production: evals before launch, retries + fallbacks after, cost ceilings baked in. Comfortable with Claude, OpenAI, pgvector, LangGraph.',
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
  },

  /* Yearly research — `job_analysis` carries notes only. Excluded
   * from chart markers and the activity-by-section bar in analytics. */
  {
    profile: 'Senior Full-Stack Developer',
    daysAgo: 120,
    section: 'job_analysis',
    item: '100 job posts · Jul 2026',
    summary: 'Yearly job post analysis — 100 posts',
    reason:
      'Common patterns: more LLM references in B2B SaaS briefs; Playwright now mentioned ~40% of the time; MVP timelines tightening (4–8 weeks dominant).',
    before: '',
    after: '',
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
   * under their old composite names. */
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
            { lastName: { contains: '·' } },
          ],
        },
      ],
    },
  });
  if (removed.count) console.log(`• Removed ${removed.count} legacy profile(s).`);

  /* 1. Profiles — upsert by title. */
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
            tier: spec.tier,
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
            tier: spec.tier,
            url: spec.url,
            note: spec.note,
            active: spec.active,
          },
        });
    if (spec.title) profileByName.set(spec.title, row.id);
  }
  console.log(`✓ Profiles: ${profileByName.size}`);

  /* 2. Change-log — remove this seed's demo entries first so re-
   * running stays idempotent. */
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const seedSummaries = CHANGE_LOG.map((c) => c.summary);
  await prisma.upworkChangeLog.deleteMany({
    where: { summary: { in: seedSummaries } },
  });
  let changeLogN = 0;
  for (const c of CHANGE_LOG) {
    const profileId = profileByName.get(c.profile);
    if (!profileId) continue;
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
      },
    });
    changeLogN++;
  }
  console.log(`✓ Change-log entries: ${changeLogN}`);

  /* 3. Metrics snapshots — wipe + regenerate deterministically.
   *    Positions carry the phrase inline (no reference-data join). */
  let snapN = 0;
  for (const spec of SNAPSHOT_SPECS) {
    const profileId = profileByName.get(spec.profile);
    if (!profileId) continue;

    await prisma.upworkMetricsSnapshot.deleteMany({ where: { profileId } });

    const rand = seededRand(spec.profile);
    for (let d = spec.days - 1; d >= 0; d--) {
      const date = new Date(now - d * dayMs);
      const dow = date.getUTCDay();
      const weekendMult = dow === 0 || dow === 6 ? 0.65 : 1;
      const progress = 1 + ((spec.days - d) / spec.days) * 0.35;
      const views = Math.max(
        0,
        Math.round(
          (spec.viewsBase + (rand() - 0.5) * spec.viewsVar) *
            weekendMult *
            progress,
        ),
      );
      const invites = Math.max(
        0,
        Math.round(
          (spec.invitesBase + (rand() - 0.5) * spec.invitesVar) *
            weekendMult *
            progress,
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

      const positions =
        d % 3 === 0
          ? spec.positionsByPhrase.map((p) => {
              const rankDecay = 1 - ((spec.days - d) / spec.days) * 0.4;
              const pos = Math.max(
                1,
                Math.round((p.base + (rand() - 0.5) * p.var) * rankDecay),
              );
              return { phrase: p.phrase, position: pos };
            })
          : [];

      await prisma.upworkMetricsSnapshot.create({
        data: {
          date,
          profileId,
          views,
          invites,
          directMessages,
          positions: positions.length
            ? { create: positions }
            : undefined,
        },
      });
      snapN++;
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
