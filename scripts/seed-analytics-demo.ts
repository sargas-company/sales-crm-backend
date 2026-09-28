/* eslint-disable no-console */
/**
 * Local-only demo seeder for the Sales Analytics Overview.
 *
 * Populates the fields the existing AnalyticsService reads:
 *   • JobPost — createdAt, matchScore, hSkillsKeywords, location,
 *     title, jobUrl, rawText, budget, totalSpent, hireRate, status,
 *     processedAt, chatId + messageId (identity), rawPayload.
 *   • JobPostIngestEvent — receivedAt, processedAt, error,
 *     idempotencyKey, source, payload.
 *
 * Idempotent: every row inserted here is tagged with a demo marker
 *   – JobPost.chatId = 'demo-overview'
 *   – JobPostIngestEvent.idempotencyKey starts with 'demo-overview:'
 * On rerun the seeder deletes only its own tagged rows before
 * inserting a fresh batch. It never touches any other row.
 *
 * Guarded by the same five signals as scripts/assert-local-db.ts to
 * make sure it can only run against the local dev database.
 */
import 'dotenv/config';
import { PrismaClient, JobPostStatus, Prisma } from '@prisma/client';

// ─── Local-DB guard ─────────────────────────────────────────────────────────

const HOST_ALLOWLIST = ['localhost', '127.0.0.1', '::1'];
const EXPECTED_PORT = '5433';
const DB_NAME_ALLOWLIST = ['ai_dashboard'];

function assertLocal(): void {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== 'local') {
    console.error(`seed-analytics-demo: APP_ENV="${appEnv ?? ''}" — refusing`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('seed-analytics-demo: DATABASE_URL not set — refusing');
    process.exit(1);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error('seed-analytics-demo: DATABASE_URL not parseable — refusing');
    process.exit(1);
  }
  if (!HOST_ALLOWLIST.includes(parsed.hostname)) {
    console.error(`seed-analytics-demo: host="${parsed.hostname}" not local — refusing`);
    process.exit(1);
  }
  if (parsed.port !== EXPECTED_PORT) {
    console.error(`seed-analytics-demo: port="${parsed.port}" != ${EXPECTED_PORT} — refusing`);
    process.exit(1);
  }
  const db = parsed.pathname.replace(/^\//, '');
  if (!DB_NAME_ALLOWLIST.includes(db)) {
    console.error(`seed-analytics-demo: db="${db}" not in allow-list — refusing`);
    process.exit(1);
  }
}

// ─── Deterministic PRNG ─────────────────────────────────────────────────────

// mulberry32 — same output every run so the demo dataset is stable.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rng() * arr.length)];

const int = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

const chance = (rng: () => number, p: number): boolean => rng() < p;

// ─── Realistic content pools ────────────────────────────────────────────────

const DEMO_CHAT_ID = 'demo-overview';
const DEMO_IK_PREFIX = 'demo-overview:';

const TITLES = [
  'Senior Full-Stack Developer for SaaS Dashboard',
  'React / TypeScript Frontend Engineer',
  'Node.js Backend Developer (Scalable APIs)',
  'Python + Django Rebuild — Long-term',
  'Next.js Marketing Site with Headless CMS',
  'DevOps Engineer — AWS, Terraform, Kubernetes',
  'GraphQL API design for fintech MVP',
  'Postgres query tuning and schema audit',
  'Data engineering pipeline in Airflow + dbt',
  'Full-stack MVP for AI copilot',
  'Vue.js migration to Nuxt 3',
  'FastAPI + React for internal admin console',
  'Mobile app — React Native, Supabase backend',
  'Chrome extension for outbound sales automation',
  'Analytics dashboard with D3 and Recharts',
  'Rust backend microservice for image processing',
  'Go microservice — GRPC + Postgres',
  'Ruby on Rails legacy modernization',
  'Payment integration (Stripe, Adyen)',
  'Elasticsearch relevance tuning',
  'Prompt engineering for RAG assistant',
  'MLOps engineer — Kubeflow + AWS SageMaker',
  'Long-term React frontend engineer — Web3',
  'Webflow → Next.js migration',
  'CTO-as-a-service for early stage startup',
  'B2B onboarding flow rebuild (React + Node)',
  'Multi-tenant billing module in NestJS',
  'Design system engineer — tokens, Storybook',
  'PostgREST + PostgreSQL for internal APIs',
  'Real-time collab editor (Yjs + WebSocket)',
] as const;

const TECH_POOL = [
  'React', 'TypeScript', 'Next.js', 'Node.js', 'NestJS', 'Python', 'Django',
  'FastAPI', 'PostgreSQL', 'MongoDB', 'Redis', 'AWS', 'Terraform', 'Kubernetes',
  'Docker', 'GraphQL', 'Vue.js', 'Nuxt.js', 'Rust', 'Go', 'Ruby on Rails',
  'Elasticsearch', 'Airflow', 'dbt', 'Snowflake', 'Stripe', 'Supabase',
  'React Native', 'D3', 'Recharts', 'Prisma', 'WebSockets', 'Kafka', 'Redux',
] as const;

const COUNTRIES = [
  'US', 'UK', 'DE', 'CA', 'AU', 'NL', 'FR', 'SE', 'CH', 'AE', 'SG', 'NO', 'IE',
] as const;

const FIXED_BUDGETS = [
  '$500', '$800', '$1,200', '$1,800', '$2,500', '$3,500', '$5,000', '$7,500',
  '$10,000', '$15,000', '$22,000', '$35,000',
] as const;

const HOURLY_BUDGETS = [
  '$20-30/h', '$25-40/h', '$30-50/h', '$40-60/h', '$50-75/h', '$60-90/h',
  '$75-100/h', '$80-120/h', '$100-150/h',
] as const;

const DESCRIPTION_TEMPLATES = [
  'We are looking for a seasoned engineer to join our team on a long-term basis. The role focuses on {tech_a} and {tech_b}, delivering iteratively into production. Strong English required.',
  'Small remote team building a niche B2B SaaS. Current stack is {tech_a} + {tech_b}. We need someone who can own features end-to-end and communicate clearly.',
  'Ongoing engagement to rebuild an internal tool. Familiarity with {tech_a}, {tech_b} and modern testing practices is essential. Detailed spec available on call.',
  'Fast-growing marketplace, seeking a contractor to help ship the next milestone. Comfort with {tech_a} and pragmatic {tech_b} choices matters more than years on paper.',
  'Trial project first, then move to a rolling monthly retainer if it works. {tech_a} + {tech_b} stack. Async-first, one 30-min sync per week.',
  'We already have a working MVP built with {tech_a}; now we need someone to harden it, add {tech_b} integrations, and ship a public beta.',
] as const;

// ─── Time-window helpers ────────────────────────────────────────────────────

const MS_MIN = 60_000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;

/**
 * Distribute a timestamp across the past `maxDaysBack` days, biased
 * toward the recent portion so 7-day filters are dense enough for the
 * KPI confidence heuristic to reach "medium".
 */
function biasedTimestamp(rng: () => number, now: number, maxDaysBack: number): number {
  // Two-bucket bias: 60% in the past 10 days, 40% between 10 and maxDaysBack.
  const inRecent = chance(rng, 0.6);
  const daysBack = inRecent
    ? rng() * Math.min(10, maxDaysBack)
    : 10 + rng() * Math.max(0, maxDaysBack - 10);
  // Bias hour toward working hours (09:00–19:00 Kyiv, 06:00–16:00 UTC).
  const workingHour = chance(rng, 0.72);
  const hour = workingHour ? int(rng, 6, 16) : int(rng, 0, 23);
  const minute = int(rng, 0, 59);
  const ts = now - daysBack * MS_DAY;
  const d = new Date(ts);
  d.setUTCHours(hour, minute, int(rng, 0, 59), 0);
  return d.getTime();
}

// ─── Score / budget distributions ───────────────────────────────────────────

function pickScore(rng: () => number): number | null {
  // ~8% ingested-but-not-yet-analyzed rows return null.
  if (chance(rng, 0.08)) return null;
  const r = rng();
  if (r < 0.18) return int(rng, 5, 24); // low
  if (r < 0.36) return int(rng, 25, 49); // near-miss
  if (r < 0.66) return int(rng, 50, 74); // qualified
  if (r < 0.88) return int(rng, 75, 89); // hot
  return int(rng, 90, 100); // top hot
}

function pickBudget(rng: () => number): {
  budget: string;
  totalSpent: number | null;
  hireRate: number | null;
} {
  const hourly = chance(rng, 0.55);
  const budget = hourly ? pick(rng, HOURLY_BUDGETS) : pick(rng, FIXED_BUDGETS);
  // Client history — biased toward mid tiers so recent-high-score rows
  // display a mix of Elite / Strong / Standard / New badges.
  const tier = rng();
  let totalSpent: number | null;
  let hireRate: number | null;
  if (tier < 0.12) {
    totalSpent = int(rng, 55000, 250000); // elite
    hireRate = 0.55 + rng() * 0.4;
  } else if (tier < 0.35) {
    totalSpent = int(rng, 10000, 45000); // strong
    hireRate = 0.4 + rng() * 0.35;
  } else if (tier < 0.75) {
    totalSpent = int(rng, 1000, 8000); // standard
    hireRate = 0.25 + rng() * 0.35;
  } else if (tier < 0.9) {
    totalSpent = int(rng, 100, 800); // new
    hireRate = 0.15 + rng() * 0.25;
  } else {
    totalSpent = null; // unverified
    hireRate = null;
  }
  return { budget, totalSpent, hireRate };
}

function pickTechs(rng: () => number): string[] {
  const count = int(rng, 2, 5);
  const s = new Set<string>();
  while (s.size < count) s.add(pick(rng, TECH_POOL));
  return Array.from(s);
}

function pickDescription(rng: () => number, techs: string[]): string {
  const tpl = pick(rng, DESCRIPTION_TEMPLATES);
  const [a, b] = [techs[0] ?? 'React', techs[1] ?? 'Node.js'];
  return tpl.replace('{tech_a}', a).replace('{tech_b}', b);
}

// ─── Seeder core ────────────────────────────────────────────────────────────

const JOB_POST_COUNT = 360;
const INGEST_EVENT_COUNT = 90;

async function main() {
  assertLocal();
  const prisma = new PrismaClient();
  await prisma.$connect();

  // 1. Clean up prior demo rows (own marker only).
  const deletedJobs = await prisma.jobPost.deleteMany({
    where: { chatId: DEMO_CHAT_ID },
  });
  const deletedEvents = await prisma.jobPostIngestEvent.deleteMany({
    where: { idempotencyKey: { startsWith: DEMO_IK_PREFIX } },
  });
  console.log(
    `cleanup: JobPost=${deletedJobs.count}, JobPostIngestEvent=${deletedEvents.count}`,
  );

  const now = Date.now();
  const rng = makeRng(0x5a9e_1c17);

  // 2. Insert JobPost rows.
  const jobPosts: Prisma.JobPostCreateManyInput[] = [];
  for (let i = 0; i < JOB_POST_COUNT; i++) {
    const createdMs = biasedTimestamp(rng, now, 45);
    const createdAt = new Date(createdMs);
    const score = pickScore(rng);
    const techs = pickTechs(rng);
    const title = pick(rng, TITLES);
    const description = pickDescription(rng, techs);
    const { budget, totalSpent, hireRate } = pickBudget(rng);
    const location = pick(rng, COUNTRIES);
    const isAnalyzed = score !== null;
    const processedAt = isAnalyzed
      ? new Date(createdMs + int(rng, 30_000, 5 * MS_MIN))
      : null;
    const status: JobPostStatus = isAnalyzed
      ? 'PROCESSED'
      : chance(rng, 0.4)
        ? 'PROCESSING'
        : 'NEW';
    const decision =
      score == null
        ? null
        : score >= 75
          ? 'approve'
          : score >= 50
            ? 'maybe'
            : 'decline';
    const priority =
      score == null
        ? null
        : score >= 85
          ? 'high'
          : score >= 55
            ? 'medium'
            : 'low';

    jobPosts.push({
      chatId: DEMO_CHAT_ID,
      messageId: 10000 + i,
      rawText: description,
      rawPayload: { demo: true, source: 'analytics-seed' } as Prisma.InputJsonValue,
      status,
      decision,
      matchScore: score ?? undefined,
      priority,
      aiResponse:
        score == null
          ? undefined
          : ({ score, techs, decision } as Prisma.InputJsonValue),
      title,
      jobUrl: `https://www.upwork.com/jobs/~demo-${i}${(i * 31).toString(36)}`,
      scanner: 'demo',
      location,
      budget,
      totalSpent: totalSpent ?? undefined,
      hireRate: hireRate ?? undefined,
      hSkillsKeywords: techs,
      createdAt,
      processedAt: processedAt ?? undefined,
    });
  }
  const jobResult = await prisma.jobPost.createMany({
    data: jobPosts,
    skipDuplicates: true,
  });
  console.log(`inserted JobPost: ${jobResult.count}`);

  // 3. Insert JobPostIngestEvent rows (Scanner Health source).
  const events: Prisma.JobPostIngestEventCreateManyInput[] = [];
  // First a very-recent burst (last hour + today) so scanner-health shows
  // status='running' and non-zero receivedLastHour / receivedToday.
  const veryRecent = 8;
  for (let i = 0; i < veryRecent; i++) {
    const receivedMs = now - int(rng, 2 * MS_MIN, 55 * MS_MIN);
    const processedMs = receivedMs + int(rng, 20_000, 3 * MS_MIN);
    events.push({
      source: 'VIBE_WORKER',
      idempotencyKey: `${DEMO_IK_PREFIX}recent:${i}`,
      payload: {
        demo: true,
        title: pick(rng, TITLES),
      } as Prisma.InputJsonValue,
      status: 'RECEIVED',
      receivedAt: new Date(receivedMs),
      processedAt: new Date(processedMs),
      attempts: 1,
    });
  }
  // Rest spread across the past 30 days.
  for (let i = 0; i < INGEST_EVENT_COUNT - veryRecent; i++) {
    const receivedMs = biasedTimestamp(rng, now, 30);
    const analyzed = chance(rng, 0.7);
    const errored = !analyzed && chance(rng, 0.18);
    events.push({
      source: 'VIBE_WORKER',
      idempotencyKey: `${DEMO_IK_PREFIX}back:${i}`,
      payload: {
        demo: true,
        title: pick(rng, TITLES),
      } as Prisma.InputJsonValue,
      status: 'RECEIVED',
      receivedAt: new Date(receivedMs),
      processedAt: analyzed
        ? new Date(receivedMs + int(rng, 20_000, 4 * MS_MIN))
        : undefined,
      error: errored ? 'demo: mapper timeout' : undefined,
      attempts: analyzed ? 1 : errored ? int(rng, 1, 3) : 0,
    });
  }
  const eventResult = await prisma.jobPostIngestEvent.createMany({
    data: events,
    skipDuplicates: true,
  });
  console.log(`inserted JobPostIngestEvent: ${eventResult.count}`);

  // 4. Sanity summary — counts on the demo rows only.
  const totalJobs = await prisma.jobPost.count({ where: { chatId: DEMO_CHAT_ID } });
  const qualified = await prisma.jobPost.count({
    where: { chatId: DEMO_CHAT_ID, matchScore: { gte: 50 } },
  });
  const hot = await prisma.jobPost.count({
    where: { chatId: DEMO_CHAT_ID, matchScore: { gte: 75 } },
  });
  const events24h = await prisma.jobPostIngestEvent.count({
    where: {
      idempotencyKey: { startsWith: DEMO_IK_PREFIX },
      receivedAt: { gte: new Date(now - MS_DAY) },
    },
  });
  console.log(
    `summary: JobPosts=${totalJobs} (qualified=${qualified}, hot=${hot}); IngestEvents 24h=${events24h}`,
  );

  await prisma.$disconnect();
  console.log('DONE');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
