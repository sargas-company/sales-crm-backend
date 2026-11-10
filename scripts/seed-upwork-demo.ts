/**
 * Upwork module demo seed — profiles, change-log entries, keywords
 * (per-profile tracked-phrase catalogue) and metrics snapshots.
 * Identity is `firstName + lastName` (profile.title was dropped).
 * Idempotent: re-running updates the matched profile in place and
 * prunes same-name duplicates created by earlier seed revisions.
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
  key: string;
  firstName: string;
  lastName: string | null;
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
    tier: 'primary',
    url: 'https://www.upwork.com/freelancers/senior-fullstack-react-node',
    note: 'Primary profile. React 18 / TypeScript / NestJS / Postgres. US and EU time zones.',
    active: true,
  },
  {
    key: 'olha',
    firstName: 'Olha',
    lastName: 'Kovalenko',
    tier: 'primary',
    url: 'https://www.upwork.com/freelancers/ai-llm-engineer',
    note: 'LLM apps, Claude + OpenAI, retrieval, evals.',
    active: true,
  },
  {
    key: 'anna',
    firstName: 'Anna',
    lastName: 'Petrenko',
    tier: 'secondary',
    url: 'https://www.upwork.com/freelancers/rn-mobile',
    note: 'Worker profile. Monthly stats only; rarely re-tuned.',
    active: true,
  },
  {
    key: 'dmytro',
    firstName: 'Dmytro',
    lastName: 'Sarafaniuk',
    tier: 'secondary',
    url: 'https://www.upwork.com/freelancers/devops-aws-iac',
    note: 'Archived — reactivate if DevOps leads start arriving.',
    active: false,
  },
];

const profileFullName = (p: Pick<ProfileSpec, 'firstName' | 'lastName'>) =>
  `${p.firstName} ${p.lastName ?? ''}`.trim();

interface ChangeLogSpec {
  profile: string;
  daysAgo: number;
  section: UpworkChangeLogSection;
  note: string;
}

const CHANGE_LOG: ChangeLogSpec[] = [
  {
    profile: 'Vadym Chervonchenko',
    daysAgo: 85,
    section: 'title',
    note: 'Pivoted the title to React-first phrasing.',
  },
  {
    profile: 'Vadym Chervonchenko',
    daysAgo: 70,
    section: 'overview',
    note: 'Rewrote overview around outcomes, not stack.',
  },
  {
    profile: 'Vadym Chervonchenko',
    daysAgo: 55,
    section: 'portfolio',
    note: 'Added CRM case study with before/after screenshots.',
  },
  {
    profile: 'Vadym Chervonchenko',
    daysAgo: 40,
    section: 'skills',
    note: 'Trimmed skills list from 24 to 12.',
  },
  {
    profile: 'Vadym Chervonchenko',
    daysAgo: 20,
    section: 'project_catalog',
    note: 'Rewrote the "MVP in 6 weeks" catalog around deliverables.',
  },
  {
    profile: 'Vadym Chervonchenko',
    daysAgo: 10,
    section: 'portfolio',
    note: 'Added second portfolio case: healthcare dashboard.',
  },

  {
    profile: 'Olha Kovalenko',
    daysAgo: 60,
    section: 'title',
    note: 'Opened AI profile with LLM-first phrasing.',
  },
  {
    profile: 'Olha Kovalenko',
    daysAgo: 45,
    section: 'overview',
    note: 'First AI overview focused on evals and production.',
  },
  {
    profile: 'Olha Kovalenko',
    daysAgo: 25,
    section: 'portfolio',
    note: 'Added first AI portfolio case: legal-ops assistant.',
  },
  {
    profile: 'Olha Kovalenko',
    daysAgo: 6,
    section: 'certificate',
    note: 'Added Anthropic prompt-engineering certificate.',
  },

  {
    profile: 'Anna Petrenko',
    daysAgo: 50,
    section: 'title',
    note: 'Opened Mobile profile with narrow RN focus.',
  },
];

/* ─── Snapshot + keyword generator ───────────────────────────── */

interface KeywordSpec {
  text: string;
  base: number;
  var: number;
}

interface SnapshotProfileSpec {
  profile: string;
  days: number;
  viewsBase: number;
  viewsVar: number;
  invitesBase: number;
  invitesVar: number;
  directMsgsBase: number;
  directMsgsVar: number;
  /** First keyword in the list is marked primary. */
  keywords: KeywordSpec[];
}

const SNAPSHOT_SPECS: SnapshotProfileSpec[] = [
  {
    profile: 'Vadym Chervonchenko',
    days: 180,
    viewsBase: 85,
    viewsVar: 50,
    invitesBase: 7,
    invitesVar: 6,
    directMsgsBase: 4,
    directMsgsVar: 5,
    keywords: [
      { text: 'senior react developer', base: 18, var: 8 },
      { text: 'full stack typescript engineer', base: 24, var: 10 },
      { text: 'nestjs postgres backend', base: 12, var: 6 },
      { text: 'react native specialist', base: 42, var: 15 },
    ],
  },
  {
    profile: 'Olha Kovalenko',
    days: 120,
    viewsBase: 56,
    viewsVar: 36,
    invitesBase: 5,
    invitesVar: 5,
    directMsgsBase: 3,
    directMsgsVar: 4,
    keywords: [
      { text: 'llm applications engineer', base: 10, var: 5 },
      { text: 'rag pipeline builder', base: 20, var: 8 },
      { text: 'ai agents developer', base: 15, var: 7 },
    ],
  },
  {
    profile: 'Anna Petrenko',
    days: 75,
    viewsBase: 34,
    viewsVar: 24,
    invitesBase: 3,
    invitesVar: 3,
    directMsgsBase: 2,
    directMsgsVar: 3,
    keywords: [{ text: 'react native mobile engineer', base: 35, var: 12 }],
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

  /* 1. Profiles — upsert by (firstName, lastName). */
  const profileByName = new Map<string, string>();
  for (const spec of PROFILES) {
    const existing = await prisma.upworkProfile.findMany({
      where: { firstName: spec.firstName, lastName: spec.lastName },
      orderBy: { createdAt: 'asc' },
    });
    let keptId: string;
    if (existing.length === 0) {
      const row = await prisma.upworkProfile.create({
        data: {
          firstName: spec.firstName,
          lastName: spec.lastName,
          tier: spec.tier,
          url: spec.url,
          note: spec.note,
          active: spec.active,
        },
      });
      keptId = row.id;
    } else {
      const [first, ...dupes] = existing;
      if (dupes.length) {
        await prisma.upworkProfile.deleteMany({
          where: { id: { in: dupes.map((d) => d.id) } },
        });
        console.log(
          `• Pruned ${dupes.length} duplicate(s) of ${profileFullName(spec)}.`,
        );
      }
      const row = await prisma.upworkProfile.update({
        where: { id: first.id },
        data: {
          tier: spec.tier,
          url: spec.url,
          note: spec.note,
          active: spec.active,
        },
      });
      keptId = row.id;
    }
    profileByName.set(profileFullName(spec), keptId);
  }
  console.log(`✓ Profiles: ${profileByName.size}`);

  /* 2. Change-log — remove this seed's demo entries first. */
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const seedNotes = CHANGE_LOG.map((c) => c.note);
  await prisma.upworkChangeLog.deleteMany({
    where: { note: { in: seedNotes } },
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
        note: c.note,
      },
    });
    changeLogN++;
  }
  console.log(`✓ Change-log entries: ${changeLogN}`);

  /* 3. Snapshots + keywords — wipe snapshots, upsert keyword catalogue
   *    per profile (first in the list is primary), regenerate
   *    snapshots deterministically with FK-shaped positions. */
  let snapN = 0;
  let kwN = 0;
  for (const spec of SNAPSHOT_SPECS) {
    const profileId = profileByName.get(spec.profile);
    if (!profileId) continue;

    /* Snapshot rows have ON DELETE CASCADE to positions, but keywords
     * are FK-restricted from positions — so wipe snapshots first. */
    await prisma.upworkMetricsSnapshot.deleteMany({ where: { profileId } });

    const kwIds: string[] = [];
    for (let i = 0; i < spec.keywords.length; i++) {
      const { text } = spec.keywords[i];
      const isPrimary = i === 0;
      const kw = await prisma.upworkKeyword.upsert({
        where: { profileId_text: { profileId, text } },
        create: { profileId, text, isPrimary, isActive: true },
        update: { isPrimary, isActive: true },
      });
      kwIds.push(kw.id);
      kwN++;
    }

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
          ? spec.keywords.map((k, i) => {
              const rankDecay = 1 - ((spec.days - d) / spec.days) * 0.4;
              const pos = Math.max(
                1,
                Math.round((k.base + (rand() - 0.5) * k.var) * rankDecay),
              );
              return { keywordId: kwIds[i], position: pos };
            })
          : [];

      await prisma.upworkMetricsSnapshot.create({
        data: {
          date,
          profileId,
          views,
          invites,
          directMessages,
          positions: positions.length ? { create: positions } : undefined,
        },
      });
      snapN++;
    }
  }
  console.log(`✓ Keywords: ${kwN}`);
  console.log(`✓ Snapshots: ${snapN}`);
  console.log('🌱 done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
