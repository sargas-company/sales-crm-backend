/* eslint-disable no-console */
/**
 * Local-only demo seeder for Employees / Projects / Project Reports.
 *
 * Idempotency: every demo row is tagged.
 *   • Employee.email ends with '@sargas-demo.dev'
 *   • Counterparty.lastName === '(demo)' — only demo clients we create
 *     ourselves; existing non-demo clients are preserved and re-used.
 *   • Project.name starts with '[DEMO] '
 *   • ProjectReport.content ends with '\n\n[demo]'
 *
 * On rerun the seeder deletes only its own tagged rows (in dependency
 * order — reports → memberships → projects → employees → demo clients)
 * before inserting a fresh batch. Existing real rows are never touched.
 *
 * Guarded by the same five signals as scripts/assert-local-db.ts so it
 * can only run against the local dev database.
 *
 * Usage:  APP_ENV=local npx ts-node scripts/seed-employees-projects-demo.ts
 *   or:   make local-seed-demo
 */
import 'dotenv/config';
import {
  PrismaClient,
  Prisma,
  EmployeeStatus,
  ProjectStatus,
  RateType,
  PayrollStatus,
  SalaryReviewResult,
  TimeOffType,
} from '@prisma/client';

const { Decimal } = Prisma;

// ─── Local-DB guard ─────────────────────────────────────────────────────────

const HOST_ALLOWLIST = ['localhost', '127.0.0.1', '::1'];
const EXPECTED_PORT = '5433';
const DB_NAME_ALLOWLIST = ['ai_dashboard'];

function assertLocal(): void {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== 'local') {
    console.error(`seed-employees-projects-demo: APP_ENV="${appEnv ?? ''}" — refusing`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('seed-employees-projects-demo: DATABASE_URL not set — refusing');
    process.exit(1);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error('seed-employees-projects-demo: DATABASE_URL not parseable — refusing');
    process.exit(1);
  }
  if (!HOST_ALLOWLIST.includes(parsed.hostname)) {
    console.error(`seed-employees-projects-demo: host="${parsed.hostname}" not local — refusing`);
    process.exit(1);
  }
  if (parsed.port !== EXPECTED_PORT) {
    console.error(`seed-employees-projects-demo: port="${parsed.port}" != ${EXPECTED_PORT} — refusing`);
    process.exit(1);
  }
  const db = parsed.pathname.replace(/^\//, '');
  if (!DB_NAME_ALLOWLIST.includes(db)) {
    console.error(`seed-employees-projects-demo: db="${db}" not in allow-list — refusing`);
    process.exit(1);
  }
}

// ─── Deterministic PRNG ─────────────────────────────────────────────────────

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

// Sample n unique elements from arr (Fisher-Yates on a copy).
function sampleN<T>(rng: () => number, arr: readonly T[], n: number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

// ─── Demo content pools ─────────────────────────────────────────────────────

const DEMO_EMAIL_DOMAIN = '@sargas-demo.dev';
const DEMO_CLIENT_LASTNAME = '(demo)';
const DEMO_PROJECT_PREFIX = '[DEMO] ';
const DEMO_REPORT_SUFFIX = '\n\n[demo]';
const DEMO_TIMEOFF_SUFFIX = '\n\n[demo-time-off]';
const DEMO_PAYROLL_NOTE_SUFFIX = '\n\n[demo-payroll]';
const DEMO_REVIEW_NOTE_SUFFIX = '\n\n[demo-review]';
const DEMO_PAYMENT_SOURCE_SUFFIX = ' (demo)';
const DEMO_LINKEDIN_ACCOUNT_SUFFIX = ' (demo)';
const DEMO_LINKEDIN_IDEA_SUFFIX = ' (demo)';
const DEMO_LINKEDIN_POST_SUFFIX = ' (demo)';

const POSITIONS = [
  'Manager',
  'Developer',
  'Lead Developer',
  'QA',
  'Designer',
  'DevOps',
] as const;

// 14 employees.
const EMPLOYEES: Array<{
  firstName: string;
  lastName: string;
  positions: (typeof POSITIONS)[number][];
  status: EmployeeStatus;
  hiredMonthsAgo: number;
  phone?: string;
}> = [
  { firstName: 'Alice',   lastName: 'Whitaker', positions: ['Manager'], status: 'active', hiredMonthsAgo: 40, phone: '+380 44 200 10 01' },
  { firstName: 'Bohdan',  lastName: 'Melnyk',   positions: ['Lead Developer', 'Developer'], status: 'active', hiredMonthsAgo: 34, phone: '+380 44 200 10 02' },
  { firstName: 'Catalina', lastName: 'Rojas',   positions: ['Developer'], status: 'active', hiredMonthsAgo: 22 },
  { firstName: 'Devin',   lastName: 'Okafor',   positions: ['Developer', 'DevOps'], status: 'active', hiredMonthsAgo: 28, phone: '+1 415 555 0134' },
  { firstName: 'Elena',   lastName: 'Kravets',  positions: ['QA'], status: 'active', hiredMonthsAgo: 18 },
  { firstName: 'Farrukh', lastName: 'Nazarov',  positions: ['Developer'], status: 'active', hiredMonthsAgo: 12 },
  { firstName: 'Gwen',    lastName: 'Iversen',  positions: ['Designer'], status: 'active', hiredMonthsAgo: 26, phone: '+45 30 12 34 56' },
  { firstName: 'Hikari',  lastName: 'Tanaka',   positions: ['Designer', 'QA'], status: 'active', hiredMonthsAgo: 14 },
  { firstName: 'Ivo',     lastName: 'Pereira',  positions: ['DevOps'], status: 'active', hiredMonthsAgo: 30, phone: '+351 21 000 0000' },
  { firstName: 'Julia',   lastName: 'Reinhardt', positions: ['Manager', 'Lead Developer'], status: 'active', hiredMonthsAgo: 46 },
  { firstName: 'Kaan',    lastName: 'Yavuz',    positions: ['Developer'], status: 'active', hiredMonthsAgo: 8 },
  { firstName: 'Liam',    lastName: 'Fitzpatrick', positions: ['QA', 'Developer'], status: 'inactive', hiredMonthsAgo: 55 },
  { firstName: 'Maya',    lastName: 'Bergström', positions: ['Designer'], status: 'inactive', hiredMonthsAgo: 20 },
  { firstName: 'Nikolai', lastName: 'Voronov',  positions: ['Lead Developer'], status: 'active', hiredMonthsAgo: 38, phone: '+7 495 000 00 00' },
];

// Extra demo clients — used only when the workspace has fewer than 4
// existing non-demo client-type counterparties. Each row is tagged with
// lastName='(demo)' so we can find and delete it on rerun.
const DEMO_CLIENTS: Array<{ firstName: string; info: string }> = [
  { firstName: 'Aurora Systems', info: 'Cloud infrastructure and observability tools.' },
  { firstName: 'BrightWave Studio', info: 'Product design & motion for consumer apps.' },
  { firstName: 'Larkspur Health', info: 'Digital health platform, HIPAA workloads.' },
  { firstName: 'Nordwind Retail', info: 'Direct-to-consumer commerce across the EU.' },
];

// 9 projects. `clientPick` = index into merged client pool.
const PROJECTS: Array<{
  name: string;
  status: ProjectStatus;
  description: string;
  memberIndexes: number[];
  startOffsetDays: number;
  endOffsetDays?: number;
}> = [
  { name: 'Payments Dashboard v2',   status: 'active',    description: 'Merchant-facing dashboard rebuild with new reconciliation flow.', memberIndexes: [1, 2, 3, 4, 7],       startOffsetDays: -120 },
  { name: 'Mobile App Rebuild',      status: 'active',    description: 'Ground-up rewrite of the consumer iOS/Android app.',              memberIndexes: [0, 3, 5, 6, 10],      startOffsetDays: -90 },
  { name: 'Internal Onboarding Tool', status: 'planned',   description: 'Employee onboarding workflow with tasks and doc signing.',       memberIndexes: [9, 4, 7],             startOffsetDays: 14 },
  { name: 'Legacy Data Migration',   status: 'active',    description: 'Move billing data from legacy MySQL cluster to managed Postgres.', memberIndexes: [1, 3, 8, 13],         startOffsetDays: -60 },
  { name: 'Design System Refresh',   status: 'active',    description: 'Consolidate component library and refresh tokens.',               memberIndexes: [6, 7, 9],             startOffsetDays: -75, endOffsetDays: 30 },
  { name: 'Marketing Site Refresh',  status: 'completed', description: 'Rebuild marketing site on Next.js with CMS integration.',         memberIndexes: [2, 6, 10],            startOffsetDays: -200, endOffsetDays: -45 },
  { name: 'Reporting Pipeline',      status: 'paused',    description: 'Analytics ETL and dashboards for finance team.',                  memberIndexes: [1, 5, 8, 11],         startOffsetDays: -160 },
  { name: 'Auth Hardening',          status: 'completed', description: 'MFA rollout, session revocation, audit hooks.',                    memberIndexes: [3, 8, 13],            startOffsetDays: -240, endOffsetDays: -60 },
  { name: 'AI Assist Pilot',         status: 'planned',   description: 'Internal pilot of an LLM assistant for support agents.',           memberIndexes: [0, 2, 5, 9, 10],      startOffsetDays: 21 },
];

const REPORT_TEMPLATES = [
  'Refactored {area} to reduce duplication; opened PR for review.',
  'Investigated {area} regression; root cause: {cause}. Fix in progress.',
  'Paired with {peer} on {area}; unblocked their branch.',
  'Wrote tests for {area}; coverage now above target.',
  'Design review with {peer}; iterated on the {area} flow.',
  'Deploy prep: {area} rehearsed on staging, waiting on QA sign-off.',
  'Migration script for {area} tested against a snapshot; passes clean.',
  'Reviewed spec for {area}; left comments on {cause}.',
  'Bugfix for {area} shipped; verified on staging.',
  'Sync with client on {area}; agreed on scope adjustment.',
  'Backfill for {area} kicked off; ETA end of day.',
  'Runbook draft for {area} committed; will circulate for review.',
];

const AREAS = [
  'the invoicing module',
  'the ingestion queue',
  'the auth flow',
  'the reporting job',
  'the admin dashboard',
  'the notification worker',
  'the analytics ETL',
  'the settings page',
  'the onboarding wizard',
  'the migration script',
  'the audit-log surface',
  'the pricing widget',
];

const CAUSES = [
  'off-by-one in the pagination cursor',
  'stale cache entry',
  'timezone mismatch',
  'race condition on retry',
  'missing index on the join',
  'incorrect enum coercion',
  'unbounded queue growth',
];

function pickPeer(rng: () => number, employees: { firstName: string; lastName: string }[], exclude: string): string {
  const others = employees.filter((e) => `${e.firstName} ${e.lastName}` !== exclude);
  if (others.length === 0) return 'the team';
  const p = pick(rng, others);
  return p.firstName;
}

function makeReportContent(
  rng: () => number,
  employees: { firstName: string; lastName: string }[],
  authorName: string,
): string {
  const template = pick(rng, REPORT_TEMPLATES);
  const area = pick(rng, AREAS);
  const cause = pick(rng, CAUSES);
  const peer = pickPeer(rng, employees, authorName);
  return template
    .replaceAll('{area}', area)
    .replaceAll('{cause}', cause)
    .replaceAll('{peer}', peer);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  assertLocal();

  const prisma = new PrismaClient();
  const rng = makeRng(0x1234_5678);

  try {
    // 1. Clean up previous demo rows (idempotency).
    console.log('==> cleaning previous demo rows (idempotent)');
    const demoProjects = await prisma.project.findMany({
      where: { name: { startsWith: DEMO_PROJECT_PREFIX } },
      select: { id: true },
    });
    const demoProjectIds = demoProjects.map((p) => p.id);
    // ProjectReport and ProjectMember cascade with Project delete, but
    // we also want to drop reports whose content is demo-tagged and
    // hanging off a real project (unlikely, but just in case).
    if (demoProjectIds.length > 0) {
      await prisma.projectReport.deleteMany({
        where: { projectId: { in: demoProjectIds } },
      });
      await prisma.projectMember.deleteMany({
        where: { projectId: { in: demoProjectIds } },
      });
      await prisma.project.deleteMany({ where: { id: { in: demoProjectIds } } });
    }
    await prisma.projectReport.deleteMany({
      where: { content: { endsWith: DEMO_REPORT_SUFFIX } },
    });
    // Time-off cleanup must run before employees; Employee cascades
    // to TimeOff, but we may have demo time-off attached to real
    // employees too, and those must go by their own note marker.
    await prisma.timeOff.deleteMany({
      where: { note: { endsWith: DEMO_TIMEOFF_SUFFIX } },
    });
    // PayrollEntry / SalaryReview / EmployeeCompensationRate cascade
    // when their employee is deleted, so we don't need explicit deletes
    // here. Payment sources are standalone; drop the tagged demo ones.
    await prisma.paymentSource.deleteMany({
      where: { name: { endsWith: DEMO_PAYMENT_SOURCE_SUFFIX } },
    });
    // LinkedIn: posts first (FK Restrict on account), then accounts, then ideas.
    // Posts have no unique demo marker on themselves, so we scope by their
    // account whose displayName is demo-tagged, plus a separate cleanup pass
    // for any orphan posts whose internalTitle carries the demo suffix.
    await prisma.linkedInPost.deleteMany({
      where: {
        OR: [
          { internalTitle: { endsWith: DEMO_LINKEDIN_POST_SUFFIX } },
          { account: { displayName: { endsWith: DEMO_LINKEDIN_ACCOUNT_SUFFIX } } },
        ],
      },
    });
    await prisma.linkedInIdea.deleteMany({
      where: { title: { endsWith: DEMO_LINKEDIN_IDEA_SUFFIX } },
    });
    await prisma.linkedInAccount.deleteMany({
      where: { displayName: { endsWith: DEMO_LINKEDIN_ACCOUNT_SUFFIX } },
    });
    await prisma.employee.deleteMany({
      where: { email: { endsWith: DEMO_EMAIL_DOMAIN } },
    });
    await prisma.counterparty.deleteMany({
      where: { lastName: DEMO_CLIENT_LASTNAME, type: 'client' },
    });

    // 2. Employees.
    console.log('==> creating employees');
    const now = new Date();
    const employees: Array<{
      id: string;
      firstName: string;
      lastName: string;
    }> = [];
    for (const e of EMPLOYEES) {
      const email = `demo.${e.firstName.toLowerCase()}.${e.lastName
        .toLowerCase()
        .replace(/[^a-z]/g, '')}${DEMO_EMAIL_DOMAIN}`;
      const hiredAt = new Date(now);
      hiredAt.setMonth(hiredAt.getMonth() - e.hiredMonthsAgo);
      const created = await prisma.employee.create({
        data: {
          firstName: e.firstName,
          lastName: e.lastName,
          email,
          phone: e.phone ?? null,
          positions: e.positions.slice(),
          status: e.status,
          hiredAt,
        },
      });
      employees.push({
        id: created.id,
        firstName: created.firstName,
        lastName: created.lastName,
      });
    }
    console.log(`   inserted ${employees.length} employees`);

    // 3. Clients: reuse existing non-demo client-type counterparties;
    //    top up with demo clients only if fewer than 4 clients exist.
    console.log('==> reconciling client counterparties');
    const existingClients = await prisma.counterparty.findMany({
      where: { type: 'client' },
      select: { id: true, firstName: true, lastName: true },
    });
    const nonDemoExisting = existingClients.filter(
      (c) => c.lastName !== DEMO_CLIENT_LASTNAME,
    );
    const clients = [...nonDemoExisting];
    if (nonDemoExisting.length < 4) {
      const need = 4 - nonDemoExisting.length;
      for (let i = 0; i < need; i++) {
        const spec = DEMO_CLIENTS[i % DEMO_CLIENTS.length];
        const created = await prisma.counterparty.create({
          data: {
            firstName: spec.firstName,
            lastName: DEMO_CLIENT_LASTNAME,
            type: 'client',
            info: spec.info,
          },
        });
        clients.push(created);
      }
    }
    console.log(`   ${clients.length} client(s) available (${clients.length - nonDemoExisting.length} demo-created)`);

    // 4. Projects.
    console.log('==> creating projects');
    const projects: Array<{
      id: string;
      name: string;
      memberIndexes: number[];
      status: 'planned' | 'active' | 'paused' | 'completed' | 'archived';
      startDate: Date;
    }> = [];
    for (let i = 0; i < PROJECTS.length; i++) {
      const p = PROJECTS[i];
      const client = clients[i % clients.length];
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() + p.startOffsetDays);
      const endDate = p.endOffsetDays !== undefined
        ? (() => {
            const d = new Date(now);
            d.setDate(d.getDate() + p.endOffsetDays);
            return d;
          })()
        : null;
      const memberSubset = p.memberIndexes.filter((idx) => idx < employees.length);
      const created = await prisma.project.create({
        data: {
          name: DEMO_PROJECT_PREFIX + p.name,
          clientId: client.id,
          status: p.status,
          description: p.description,
          startDate,
          endDate,
          members: {
            create: memberSubset.map((idx) => ({ employeeId: employees[idx].id })),
          },
        },
      });
      projects.push({
        id: created.id,
        name: created.name,
        memberIndexes: memberSubset,
        status: p.status,
        startDate,
      });
    }
    console.log(`   inserted ${projects.length} projects with team memberships`);

    // 4b. Project status history — baseline + plausible past transitions
    //     so the Projects-over-time chart on Project Analytics has movement.
    console.log('==> creating project status history');
    for (const p of projects) {
      // Wipe any previous demo baseline for idempotency. The FK is
      // CASCADE so plain delete-by-projectId is safe.
      await prisma.projectStatusHistory.deleteMany({ where: { projectId: p.id } });
      // Baseline: the project's very first status was "planned" at the
      // recorded startDate (or 90 days before today if startDate is in
      // the future / null).
      const start = p.startDate ?? new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const baseline = start < now ? start : new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
      await prisma.projectStatusHistory.create({
        data: {
          projectId: p.id,
          status: 'planned',
          effectiveAt: baseline,
        },
      });
      // Fabricate a couple of plausible transitions toward the current
      // status. We do NOT invent statuses that aren't in the enum, and
      // we don't move projects whose current status is already 'planned'.
      const transitions: Array<{ status: 'active' | 'paused' | 'completed' | 'archived'; daysAgo: number }> = [];
      switch (p.status) {
        case 'active':
          transitions.push({ status: 'active', daysAgo: 60 + Math.floor(rng() * 15) });
          break;
        case 'paused':
          transitions.push({ status: 'active', daysAgo: 70 + Math.floor(rng() * 20) });
          transitions.push({ status: 'paused', daysAgo: 25 + Math.floor(rng() * 10) });
          break;
        case 'completed':
          transitions.push({ status: 'active', daysAgo: 80 + Math.floor(rng() * 15) });
          transitions.push({ status: 'completed', daysAgo: 15 + Math.floor(rng() * 10) });
          break;
        case 'archived':
          transitions.push({ status: 'active', daysAgo: 90 + Math.floor(rng() * 20) });
          transitions.push({ status: 'archived', daysAgo: 40 + Math.floor(rng() * 15) });
          break;
        default:
          break; // 'planned' stays as baseline only.
      }
      for (const t of transitions) {
        const effectiveAt = new Date(now);
        effectiveAt.setUTCDate(effectiveAt.getUTCDate() - t.daysAgo);
        await prisma.projectStatusHistory.create({
          data: {
            projectId: p.id,
            status: t.status,
            effectiveAt,
          },
        });
      }
    }
    console.log(`   status history entries for ${projects.length} projects`);

    // 5. Reports — 240 in total, spread across projects and members over
    // the last ~120 days so the analytics page has enough history to
    // draw meaningful weekly + monthly graphs.
    console.log('==> creating project reports');
    const REPORT_COUNT = 240;
    const REPORT_MAX_AGE = 120;
    const seen = new Set<string>(); // "projectId|employeeId|YYYY-MM-DD"
    let inserted = 0;
    let attempts = 0;
    const maxAttempts = REPORT_COUNT * 20;
    while (inserted < REPORT_COUNT && attempts < maxAttempts) {
      attempts++;
      const project = pick(rng, projects);
      if (project.memberIndexes.length === 0) continue;
      const empIdx = pick(rng, project.memberIndexes);
      const emp = employees[empIdx];
      // reportDate: within the last ~120 days (skip today so nothing lands
      // on the exact same day as a rerun in the same session).
      const daysAgo = int(rng, 1, REPORT_MAX_AGE);
      const reportDate = new Date(now);
      reportDate.setUTCHours(0, 0, 0, 0);
      reportDate.setUTCDate(reportDate.getUTCDate() - daysAgo);
      // Project-day keying: one report per (project, date) regardless
      // of who filed it. The seed snapshot copies the whole project
      // team as the contributor set.
      const key = `${project.id}|${reportDate.toISOString().slice(0, 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // hours: 1.0 – 9.5 in half-hour steps.
      const hours = int(rng, 2, 19) / 2;
      const authorName = `${emp.firstName} ${emp.lastName}`;
      const body = makeReportContent(rng, employees, authorName);
      const content = `${body}${DEMO_REPORT_SUFFIX}`;
      try {
        await prisma.projectReport.create({
          data: {
            projectId: project.id,
            reportDate,
            hours,
            content,
            contributors: {
              create: project.memberIndexes.map((idx) => {
                const member = employees[idx];
                return {
                  employeeId: member.id,
                  firstNameSnapshot: member.firstName,
                  lastNameSnapshot: member.lastName,
                };
              }),
            },
          },
        });
        inserted++;
      } catch (e) {
        // unique-constraint hit despite our seen-set is rare (race with a
        // previous partial run); skip and try again.
      }
    }
    console.log(`   inserted ${inserted} reports (attempted ${attempts})`);

    // 6. Time Off — 28 records spread across employees, types and
    //    past / current / future dates. Uses the Owner user as
    //    createdBy so the record has a valid FK (real usage would
    //    stamp req.user.id from the JWT).
    console.log('==> creating time-off records');
    const owner = await prisma.user.findFirst({
      where: { email: 'admin@test.com' },
      select: { id: true },
    });
    if (!owner) {
      console.warn('   Owner user not found — skipping time-off seed');
    } else {
      const timeOffRows = buildTimeOffPlan(rng, employees);
      let inserted = 0;
      for (const row of timeOffRows) {
        const workingDays = countWorkingDays(row.startDate, row.endDate);
        if (workingDays === 0) continue;
        try {
          await prisma.timeOff.create({
            data: {
              employeeId: row.employeeId,
              type: row.type,
              startDate: row.startDate,
              endDate: row.endDate,
              workingDays,
              note: row.note + DEMO_TIMEOFF_SUFFIX,
              attachmentName: row.attachmentName,
              attachmentSize: row.attachmentSize,
              attachmentMime: row.attachmentMime,
              createdById: owner.id,
            },
          });
          inserted++;
        } catch {
          // overlap or other conflict — skip.
        }
      }
      console.log(`   inserted ${inserted} time-off records`);
    }

    // 7. Compensation — rates, payroll (8 months) and salary reviews.
    console.log('==> creating compensation rates, payroll and reviews');
    let payrollCount = 0;
    let reviewCount = 0;
    let rateCount = 0;
    for (let i = 0; i < employees.length; i++) {
      const emp = employees[i];
      // Deterministic per-employee compensation profile.
      const isMonthly = i % 5 === 0; // ~20% are on MONTHLY.
      const baseRate = isMonthly ? 3200 + i * 180 : 22 + (i % 7) * 4;
      const rateType: RateType = isMonthly ? 'MONTHLY' : 'HOURLY';
      const hireAnchor = new Date(now);
      hireAnchor.setUTCMonth(hireAnchor.getUTCMonth() - 24);

      // Initial effective-dated rate.
      await prisma.employeeCompensationRate.create({
        data: {
          employeeId: emp.id,
          rateType,
          rate: new Decimal(baseRate),
          effectiveDate: hireAnchor,
          note: 'Demo baseline rate',
        },
      });
      rateCount++;

      // Payroll for the last 8 months.
      for (let back = 7; back >= 0; back--) {
        const target = new Date(now);
        target.setUTCDate(1);
        target.setUTCMonth(target.getUTCMonth() - back);
        const year = target.getUTCFullYear();
        const month = target.getUTCMonth() + 1;
        const hours =
          rateType === 'HOURLY' ? new Decimal(int(rng, 120, 172)) : null;
        const rate = new Decimal(baseRate);
        const bonusPercent = new Decimal(back % 3 === 0 ? 5 : 0);
        const fixedBonus = new Decimal(back === 0 ? 0 : back % 4 === 0 ? 150 : 0);
        const advance = new Decimal(back % 2 === 0 ? 0 : int(rng, 200, 600));

        const base =
          rateType === 'HOURLY'
            ? rate.times(hours ?? new Decimal(0))
            : rate;
        const tax = new Decimal('42.5').plus(base.times('0.06'));
        const salaryWithTax = base.plus(tax);
        const bonusAmount = salaryWithTax
          .times(bonusPercent)
          .div(100)
          .plus(fixedBonus);
        const totalAccrued = salaryWithTax.plus(bonusAmount);
        const remainingRaw = totalAccrued.minus(advance);
        const remainingToPay = remainingRaw.isNegative()
          ? new Decimal(0)
          : remainingRaw;
        const payoneerFee = totalAccrued.times('0.03');
        const companyCost = totalAccrued.plus(payoneerFee);

        // Most historical rows are Paid; the last two months are Draft
        // for a couple of employees so the "Draft/Paid" mix is visible.
        const isDraft = back <= 1 && i % 4 === 0;
        try {
          await prisma.payrollEntry.create({
            data: {
              employeeId: emp.id,
              year,
              month,
              rateType,
              rate,
              hours,
              baseSalary: base.toDecimalPlaces(2),
              tax: tax.toDecimalPlaces(2),
              salaryWithTax: salaryWithTax.toDecimalPlaces(2),
              bonusPercent,
              fixedBonus,
              bonusAmount: bonusAmount.toDecimalPlaces(2),
              advance,
              totalAccrued: totalAccrued.toDecimalPlaces(2),
              remainingToPay: remainingToPay.toDecimalPlaces(2),
              payoneerFee: payoneerFee.toDecimalPlaces(2),
              companyCost: companyCost.toDecimalPlaces(2),
              note:
                back === 0
                  ? `Current month draft${DEMO_PAYROLL_NOTE_SUFFIX}`
                  : `Auto-generated payroll${DEMO_PAYROLL_NOTE_SUFFIX}`,
              status: isDraft ? PayrollStatus.DRAFT : PayrollStatus.PAID,
              paidAt: isDraft
                ? null
                : new Date(Date.UTC(year, month, 5)),
            },
          });
          payrollCount++;
        } catch {
          // ignore duplicate on rerun.
        }
      }

      // Salary reviews — completed increased for ~half, one upcoming
      // for ~third, one postponed for ~fifth. Deterministic by index.
      if (i % 2 === 0) {
        const effective = new Date(now);
        effective.setUTCDate(1);
        effective.setUTCMonth(effective.getUTCMonth() - int(rng, 3, 10));
        const scheduled = new Date(effective);
        scheduled.setUTCDate(scheduled.getUTCDate() - 14);
        const bump = isMonthly ? 400 : 3;
        const newRateValue = baseRate + bump;
        await prisma.salaryReview.create({
          data: {
            employeeId: emp.id,
            scheduledDate: dayOnly(scheduled),
            previousRateType: rateType,
            previousRate: new Decimal(baseRate),
            newRateType: rateType,
            newRate: new Decimal(newRateValue),
            effectiveDate: dayOnly(effective),
            result: SalaryReviewResult.INCREASED,
            completedAt: new Date(scheduled.getTime() + 24 * 60 * 60 * 1000),
            note: `Solid performance in the past cycle${DEMO_REVIEW_NOTE_SUFFIX}`,
          },
        });
        reviewCount++;
        await prisma.employeeCompensationRate.create({
          data: {
            employeeId: emp.id,
            rateType,
            rate: new Decimal(newRateValue),
            effectiveDate: dayOnly(effective),
            note: 'Demo INCREASED rate',
          },
        });
        rateCount++;
      }
      if (i % 3 === 0) {
        const upcoming = new Date(now);
        upcoming.setUTCDate(upcoming.getUTCDate() + int(rng, 14, 60));
        await prisma.salaryReview.create({
          data: {
            employeeId: emp.id,
            scheduledDate: dayOnly(upcoming),
            previousRateType: rateType,
            previousRate: new Decimal(baseRate),
            note: `Regular cadence check-in${DEMO_REVIEW_NOTE_SUFFIX}`,
          },
        });
        reviewCount++;
      }
      if (i % 5 === 0) {
        const postponed = new Date(now);
        postponed.setUTCMonth(postponed.getUTCMonth() - 2);
        await prisma.salaryReview.create({
          data: {
            employeeId: emp.id,
            scheduledDate: dayOnly(postponed),
            previousRateType: rateType,
            previousRate: new Decimal(baseRate),
            result: SalaryReviewResult.POSTPONED,
            note: `Delayed pending project close-out${DEMO_REVIEW_NOTE_SUFFIX}`,
          },
        });
        reviewCount++;
      }
    }

    // 8. Payment Sources.
    console.log('==> creating payment sources');
    const demoSources = [
      { name: `Payoneer USD${DEMO_PAYMENT_SOURCE_SUFFIX}`, description: 'Primary USD receiving account', currency: 'USD', isActive: true },
      { name: `Wise EUR${DEMO_PAYMENT_SOURCE_SUFFIX}`, description: 'EU-based clients', currency: 'EUR', isActive: true },
      { name: `Revolut Business${DEMO_PAYMENT_SOURCE_SUFFIX}`, description: 'Multi-currency wallet', currency: 'USD', isActive: true },
      { name: `Legacy Ukrainian Bank${DEMO_PAYMENT_SOURCE_SUFFIX}`, description: 'Deprecated — kept for archive only', currency: 'UAH', isActive: false },
    ];
    for (const s of demoSources) {
      await prisma.paymentSource.create({ data: s });
    }

    // 9. LinkedIn Workspace demo data.
    console.log('==> creating LinkedIn accounts / ideas / posts');
    const {
      accountCount,
      ideaCount,
      postCount,
    } = await seedLinkedInDemo(prisma, employees, rng);

    // 10. Summary.
    const [empCount, projCount, reportCount, timeOffCount, paymentSourceCount] = await Promise.all([
      prisma.employee.count({ where: { email: { endsWith: DEMO_EMAIL_DOMAIN } } }),
      prisma.project.count({ where: { name: { startsWith: DEMO_PROJECT_PREFIX } } }),
      prisma.projectReport.count({
        where: { content: { endsWith: DEMO_REPORT_SUFFIX } },
      }),
      prisma.timeOff.count({ where: { note: { endsWith: DEMO_TIMEOFF_SUFFIX } } }),
      prisma.paymentSource.count({ where: { name: { endsWith: DEMO_PAYMENT_SOURCE_SUFFIX } } }),
    ]);
    console.log('');
    console.log('==> demo dataset ready');
    console.log(`   employees:      ${empCount}`);
    console.log(`   projects:       ${projCount}`);
    console.log(`   reports:        ${reportCount}`);
    console.log(`   time-off:       ${timeOffCount}`);
    console.log(`   comp rates:     ${rateCount}`);
    console.log(`   payroll rows:   ${payrollCount}`);
    console.log(`   salary reviews: ${reviewCount}`);
    console.log(`   payment srcs:   ${paymentSourceCount}`);
    console.log(`   linkedin accs:  ${accountCount}`);
    console.log(`   linkedin ideas: ${ideaCount}`);
    console.log(`   linkedin posts: ${postCount}`);
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Time-off plan builder ─────────────────────────────────────────────────

interface TimeOffPlanRow {
  employeeId: string;
  type: TimeOffType;
  startDate: Date;
  endDate: Date;
  note: string;
  attachmentName: string | null;
  attachmentSize: number | null;
  attachmentMime: string | null;
}

const TIME_OFF_NOTES: Record<TimeOffType, string[]> = {
  VACATION: [
    'Family vacation in the mountains.',
    'Two-week trip to Portugal.',
    'Off-grid retreat, no laptop.',
    'Long weekend, extending a public holiday.',
    'Wedding travel; back mid-week.',
    'Recovery time between projects.',
  ],
  SICK_LEAVE: [
    'Flu; will keep the team posted.',
    'Doctor visit + recovery.',
    'Recovering from a cold; back Monday.',
    'Minor surgery, out for a few days.',
  ],
  UNPAID_LEAVE: [
    'Personal leave — family matter.',
    'Sabbatical break requested.',
    'Extended trip, unpaid balance.',
  ],
};

function dayOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function countWorkingDays(start: Date, end: Date): number {
  if (end < start) return 0;
  let count = 0;
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

function buildTimeOffPlan(
  rng: () => number,
  employees: Array<{ id: string; firstName: string; lastName: string }>,
): TimeOffPlanRow[] {
  const today = dayOnly(new Date());
  const rows: TimeOffPlanRow[] = [];

  // Per-employee per-year running totals so we don't blow past the
  // annual allowance (21 vacation / 5 sick per year). Unpaid is free.
  const usage = new Map<string, { vac: number; sick: number }>();
  const key = (empId: string, year: number) => `${empId}:${year}`;

  const tryPush = (row: TimeOffPlanRow) => {
    const wd = countWorkingDays(row.startDate, row.endDate);
    if (wd === 0) return;
    const year = row.startDate.getUTCFullYear();
    const k = key(row.employeeId, year);
    const u = usage.get(k) ?? { vac: 0, sick: 0 };
    if (row.type === 'VACATION') {
      if (u.vac + wd > 21) return;
      u.vac += wd;
    } else if (row.type === 'SICK_LEAVE') {
      if (u.sick + wd > 5) return;
      u.sick += wd;
    }
    usage.set(k, u);
    rows.push(row);
  };

  const attachmentPicks = [
    { name: 'flight-confirmation.pdf', size: 218_432, mime: 'application/pdf' },
    { name: 'doctor-note.jpg', size: 342_100, mime: 'image/jpeg' },
    { name: 'itinerary.pdf', size: 156_770, mime: 'application/pdf' },
  ];

  const addRow = (
    empIndex: number,
    type: TimeOffType,
    startOffsetDays: number,
    lengthDays: number,
  ) => {
    const emp = employees[empIndex % employees.length];
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() + startOffsetDays);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + lengthDays - 1);
    const notes = TIME_OFF_NOTES[type];
    const note = notes[Math.floor(rng() * notes.length)];
    const attach = rng() < 0.35 ? attachmentPicks[Math.floor(rng() * attachmentPicks.length)] : null;
    tryPush({
      employeeId: emp.id,
      type,
      startDate: dayOnly(start),
      endDate: dayOnly(end),
      note,
      attachmentName: attach?.name ?? null,
      attachmentSize: attach?.size ?? null,
      attachmentMime: attach?.mime ?? null,
    });
  };

  // Past absences (this year).
  addRow(0, 'VACATION', -180, 10);
  addRow(1, 'SICK_LEAVE', -160, 2);
  addRow(2, 'UNPAID_LEAVE', -140, 7);
  addRow(3, 'VACATION', -120, 5);
  addRow(4, 'VACATION', -100, 14);
  addRow(5, 'SICK_LEAVE', -85, 3);
  addRow(6, 'VACATION', -70, 4);
  addRow(7, 'UNPAID_LEAVE', -60, 3);
  addRow(8, 'VACATION', -50, 6);
  addRow(9, 'SICK_LEAVE', -40, 1);
  addRow(10, 'VACATION', -30, 4);

  // Current / very recent absences.
  addRow(0, 'SICK_LEAVE', -3, 2);
  addRow(2, 'VACATION', -2, 5);
  addRow(4, 'UNPAID_LEAVE', 0, 3);

  // Upcoming absences within the next 30–90 days.
  addRow(1, 'VACATION', 4, 5);
  addRow(3, 'VACATION', 10, 8);
  addRow(5, 'SICK_LEAVE', 14, 1);
  addRow(6, 'UNPAID_LEAVE', 20, 4);
  addRow(7, 'VACATION', 25, 3);
  addRow(9, 'VACATION', 30, 7);
  addRow(11, 'SICK_LEAVE', 35, 2);
  addRow(12, 'VACATION', 45, 10);
  addRow(13, 'VACATION', 55, 6);

  // Year-crossing case (Dec → Jan) — split accounting exercised.
  const yearEnd = new Date(Date.UTC(today.getUTCFullYear(), 11, 27));
  const yearEndDelta = Math.round(
    (yearEnd.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (yearEndDelta >= 0) {
    addRow(2, 'VACATION', yearEndDelta, 12);
  }

  // A pair of Unpaid Leaves anywhere in the visible range.
  addRow(8, 'UNPAID_LEAVE', 12, 5);
  addRow(10, 'UNPAID_LEAVE', -12, 6);

  return rows;
}

// ─── LinkedIn Workspace seed ───────────────────────────────────────────────

async function seedLinkedInDemo(
  prisma: PrismaClient,
  employees: Array<{ id: string; firstName: string; lastName: string }>,
  rng: () => number,
): Promise<{ accountCount: number; ideaCount: number; postCount: number }> {
  const today = new Date();
  const dayOffset = (delta: number, hour = 10, minute = 0): Date => {
    const d = new Date(today);
    d.setUTCHours(hour, minute, 0, 0);
    d.setUTCDate(d.getUTCDate() + delta);
    return d;
  };
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

  // Accounts — owner + Sargas company + a couple of team profiles.
  const ownerEmp = employees[0];
  const bd = employees[1];
  const lead = employees[2];

  const accountsData = [
    {
      displayName: `Vadim Chervonchenko${DEMO_LINKEDIN_ACCOUNT_SUFFIX}`,
      type: 'PERSONAL' as const,
      profileUrl: 'https://www.linkedin.com/in/vadim-chervonchenko/',
      employeeId: ownerEmp?.id ?? null,
      note: 'Owner profile — thought leadership and hiring signals.',
    },
    {
      displayName: `Sargas Consulting${DEMO_LINKEDIN_ACCOUNT_SUFFIX}`,
      type: 'COMPANY' as const,
      profileUrl: 'https://www.linkedin.com/company/sargas-consulting/',
      employeeId: null,
      note: 'Sargas company page — case studies and product news.',
    },
    {
      displayName: `${bd?.firstName ?? 'BD'} ${bd?.lastName ?? 'Rep'}${DEMO_LINKEDIN_ACCOUNT_SUFFIX}`,
      type: 'PERSONAL' as const,
      profileUrl: 'https://www.linkedin.com/in/sargas-bd/',
      employeeId: bd?.id ?? null,
      note: 'BD outreach — lead-gen posts and DM-friendly content.',
    },
    {
      displayName: `${lead?.firstName ?? 'Tech'} ${lead?.lastName ?? 'Lead'}${DEMO_LINKEDIN_ACCOUNT_SUFFIX}`,
      type: 'PERSONAL' as const,
      profileUrl: 'https://www.linkedin.com/in/sargas-tech/',
      employeeId: lead?.id ?? null,
      isActive: false,
      note: 'Archived — moved posting to the company page.',
    },
  ];
  const accounts: Array<{ id: string; displayName: string }> = [];
  for (const a of accountsData) {
    const created = await prisma.linkedInAccount.create({
      data: {
        displayName: a.displayName,
        type: a.type,
        profileUrl: a.profileUrl,
        employeeId: a.employeeId,
        isActive: a.isActive ?? true,
        note: a.note,
      },
      select: { id: true, displayName: true },
    });
    accounts.push(created);
  }

  // Ideas — 18 rows across the four statuses / three priorities.
  const IDEA_SEEDS: Array<{
    title: string;
    content: string;
    hook?: string;
    audience?: string;
    pillar?: string;
    format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LINK' | 'POLL';
    language?: string;
    priority: 'LOW' | 'MEDIUM' | 'HIGH';
    status: 'NEW' | 'IN_PROGRESS' | 'CONVERTED' | 'ARCHIVED';
    tags: string[];
    plannedOffset?: number;
  }> = [
    { title: 'Sales-loop breakdown for tiny outbound teams', content: 'Show how a 2-person BD desk builds a repeatable weekly loop: sourcing on Monday, first-touches on Tuesday, follow-ups Wed/Thu, review Friday. Include the scorecard we actually use.', hook: 'A 2-person BD desk closed 4 discovery calls last week — here is the ugly playbook.', audience: 'Solo founders & tiny outbound teams', pillar: 'sales-ops', format: 'TEXT', priority: 'HIGH', status: 'NEW', tags: ['sales', 'playbook', 'outbound'], plannedOffset: 3 },
    { title: 'Why we ditched 90% of AI-generated proposals', content: 'Case study: swapping AI first-drafts for a shorter human intro doubled reply rates. Numbers over 6 weeks. Ready-to-use email template at the end.', hook: 'We killed 90% of our AI-drafted proposals. Reply rate doubled.', audience: 'Agency & consulting owners', pillar: 'sales', format: 'DOCUMENT', priority: 'HIGH', status: 'IN_PROGRESS', tags: ['sales', 'ai', 'case-study'], plannedOffset: 6 },
    { title: 'Behind the scenes — Sargas CRM salaries module', content: 'Product update covering the new payroll module: Excel-like Monthly Run + drill-down analytics. Include 3 screenshots and a 20-sec Loom.', hook: 'We finally shipped the module that made us stop using spreadsheets for payroll.', audience: 'Product-curious founders', pillar: 'product', format: 'IMAGE', priority: 'MEDIUM', status: 'IN_PROGRESS', tags: ['product', 'behind-the-scenes'], plannedOffset: 9 },
    { title: '"Comment MVP for the AI checklist"', content: 'Lead-magnet-style post inviting comments in exchange for a private link to the AI-Delivery checklist. Include first comment with URL.', hook: 'Drop "MVP" in the comments and I will send you the AI-delivery checklist.', audience: 'AI-curious teams', pillar: 'lead-gen', format: 'TEXT', priority: 'MEDIUM', status: 'NEW', tags: ['lead-magnet'], plannedOffset: 14 },
    { title: '5 client-onboarding red flags', content: 'Short list-style post covering 5 signals we now spot on discovery calls that predict painful engagements later. Real anonymised examples.', hook: 'These 5 discovery-call signals killed our margins last year.', audience: 'Consulting & agency owners', pillar: 'sales-ops', format: 'TEXT', priority: 'MEDIUM', status: 'NEW', tags: ['sales', 'onboarding'], plannedOffset: 4 },
    { title: 'Poll — which billing model do you use?', content: 'LinkedIn poll: fixed / T&M / value / hybrid. Add commentary comparing what we see across our client base.', audience: 'B2B service ops', pillar: 'community', format: 'POLL', priority: 'LOW', status: 'NEW', tags: ['poll', 'billing'], plannedOffset: 7 },
    { title: 'How we scaled BD without a CRM (for the first year)', content: 'Retrospective: first-year Sargas ran on Notion + Airtable + Google Sheets. What broke, what to keep even after CRM adoption.', audience: 'Early-stage founders', pillar: 'founder-story', format: 'TEXT', priority: 'LOW', status: 'NEW', tags: ['founder-story'], plannedOffset: 20 },
    { title: 'Video — a 90 sec CRM walkthrough', content: 'Cut a 90-second video showing the sales-analytics dashboard and lead-to-opportunity flow. Speaker notes attached.', audience: 'Product buyers', pillar: 'product', format: 'VIDEO', priority: 'HIGH', status: 'IN_PROGRESS', tags: ['product', 'video'], plannedOffset: 11 },
    { title: 'Client win — turnaround at Aurora Systems', content: 'Public case study with client permission. Data: -47% cycle time, +12 NPS.', audience: 'Buyers evaluating consultancies', pillar: 'case-study', format: 'DOCUMENT', priority: 'MEDIUM', status: 'CONVERTED', tags: ['case-study', 'client-win'], plannedOffset: -6 },
    { title: 'Hiring — senior full-stack, remote-first', content: 'Job post announcement, LinkedIn-friendly. Highlights: remote, TypeScript-heavy stack, product mindset.', audience: 'Senior engineers', pillar: 'hiring', format: 'TEXT', priority: 'MEDIUM', status: 'CONVERTED', tags: ['hiring'], plannedOffset: -15 },
    { title: 'Q3 wrap-up thread', content: 'Recap: 3 metrics we tracked, 3 we abandoned, biggest lesson.', audience: 'Ops-minded founders', pillar: 'retrospective', format: 'TEXT', priority: 'LOW', status: 'CONVERTED', tags: ['retrospective'], plannedOffset: -20 },
    { title: 'Old idea — thought-leader roundtable', content: 'Pitch to co-host a monthly LinkedIn Live with fellow founders. Shelved after low interest.', audience: 'Founder community', pillar: 'community', format: 'LINK', priority: 'LOW', status: 'ARCHIVED', tags: ['event'] },
    { title: 'Archived — pun-heavy sales post', content: 'Draft never quite landed the right tone.', audience: 'Everyone (didn\'t work)', pillar: 'sales', format: 'TEXT', priority: 'LOW', status: 'ARCHIVED', tags: ['draft-graveyard'] },
    { title: 'Poll — pricing psychology', content: 'Which price feels "premium" to you? Test 4 anchors.', audience: 'B2B buyers', pillar: 'sales', format: 'POLL', priority: 'MEDIUM', status: 'NEW', tags: ['poll', 'pricing'], plannedOffset: 25 },
    { title: 'Framework — 3 questions to qualify AI projects', content: 'Short framework to filter "cool AI ideas" from projects worth quoting.', audience: 'CTOs & founders', pillar: 'ai', format: 'DOCUMENT', priority: 'HIGH', status: 'NEW', tags: ['framework', 'ai'], plannedOffset: 10 },
    { title: 'How we killed our internal Slackbot', content: 'Tech-debt story: why we rewrote a critical internal bot from scratch.', audience: 'Engineering leaders', pillar: 'engineering', format: 'TEXT', priority: 'LOW', status: 'IN_PROGRESS', tags: ['engineering', 'tech-debt'], plannedOffset: 18 },
    { title: 'Deck — annual review outline', content: 'Full slide deck for annual client review meetings — reusable template.', audience: 'Account managers', pillar: 'account-mgmt', format: 'DOCUMENT', priority: 'MEDIUM', status: 'NEW', tags: ['template'], plannedOffset: 30 },
    { title: 'Video — day-in-the-life of a Sargas BD', content: 'Follow one of our BDs for a day. Behind-the-scenes tone.', audience: 'Curious observers & candidates', pillar: 'culture', format: 'VIDEO', priority: 'LOW', status: 'NEW', tags: ['culture'], plannedOffset: 22 },
  ];

  const ideas: Array<{ id: string; title: string; status: string }> = [];
  for (const i of IDEA_SEEDS) {
    const owner = employees[Math.floor(rng() * employees.length)];
    const created = await prisma.linkedInIdea.create({
      data: {
        title: `${i.title}${DEMO_LINKEDIN_IDEA_SUFFIX}`,
        content: i.content,
        hook: i.hook ?? null,
        targetAudience: i.audience ?? null,
        contentPillar: i.pillar ?? null,
        suggestedFormat: (i.format as any) ?? null,
        language: i.language ?? 'en',
        priority: i.priority,
        status: i.status,
        tags: i.tags,
        referenceLinks: [],
        ownerId: owner?.id ?? null,
        plannedDate: i.plannedOffset != null ? dayOnly(dayOffset(i.plannedOffset)) : null,
      },
      select: { id: true, title: true, status: true },
    });
    ideas.push(created);
  }

  // Posts — mix of DRAFT / READY / SCHEDULED / PUBLISHED / ARCHIVED across
  // the accounts, with a few tied back to the CONVERTED ideas so idea → post
  // relations aren't empty.
  const convertedIdeas = ideas.filter((i) => i.status === 'CONVERTED');
  const inProgressIdeas = ideas.filter((i) => i.status === 'IN_PROGRESS');

  const POST_SEEDS: Array<{
    internalTitle: string;
    accountIdx: number;
    ideaIdx?: number;
    body: string;
    hook?: string;
    firstComment?: string;
    hashtags: string[];
    format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LINK' | 'POLL';
    status: 'DRAFT' | 'READY' | 'SCHEDULED' | 'PUBLISHED' | 'ARCHIVED';
    scheduledOffset?: number;
    publishedOffset?: number;
    linkedInUrl?: string;
    metrics?: {
      impressions: number;
      reactions: number;
      comments: number;
      reposts: number;
      clicks: number;
      followersGained: number;
      leadsGenerated: number;
    };
  }> = [
    {
      internalTitle: 'Aurora case study — published post',
      accountIdx: 1,
      ideaIdx: convertedIdeas[0] ? ideas.indexOf(convertedIdeas[0]) : undefined,
      body: 'Case study: Aurora Systems cut their sales-cycle time by 47% in one quarter after we rebuilt their CRM operations. Full walkthrough below.',
      hook: 'Aurora Systems cut sales-cycle time by 47% in one quarter — here is what we changed.',
      firstComment: 'Full write-up ↓ https://sargas.example/aurora',
      hashtags: ['SargasWins', 'ClientStory', 'RevOps'],
      format: 'DOCUMENT',
      status: 'PUBLISHED',
      publishedOffset: -6,
      linkedInUrl: 'https://www.linkedin.com/posts/sargas-consulting/aurora-case-study',
      metrics: { impressions: 18420, reactions: 452, comments: 87, reposts: 39, clicks: 1204, followersGained: 62, leadsGenerated: 11 },
    },
    {
      internalTitle: 'Hiring — senior FS engineer (published)',
      accountIdx: 0,
      ideaIdx: convertedIdeas[1] ? ideas.indexOf(convertedIdeas[1]) : undefined,
      body: 'We\'re hiring a senior full-stack engineer. Remote-first. TypeScript / React / NestJS. Product mindset over framework wars.',
      hook: 'Sargas is hiring a senior FS engineer — remote-first, product-heavy.',
      hashtags: ['Hiring', 'TypeScript', 'Remote'],
      format: 'TEXT',
      status: 'PUBLISHED',
      publishedOffset: -15,
      linkedInUrl: 'https://www.linkedin.com/posts/vadim-chervonchenko/hiring-fs',
      metrics: { impressions: 9420, reactions: 218, comments: 43, reposts: 19, clicks: 605, followersGained: 24, leadsGenerated: 0 },
    },
    {
      internalTitle: 'Q3 wrap-up thread (published)',
      accountIdx: 0,
      ideaIdx: convertedIdeas[2] ? ideas.indexOf(convertedIdeas[2]) : undefined,
      body: '3 metrics we tracked in Q3, 3 we quietly abandoned, 1 lesson we bought with real money.',
      hashtags: ['FoundersJourney'],
      format: 'TEXT',
      status: 'PUBLISHED',
      publishedOffset: -20,
      linkedInUrl: 'https://www.linkedin.com/posts/vadim-chervonchenko/q3-wrap',
      metrics: { impressions: 6220, reactions: 141, comments: 22, reposts: 8, clicks: 320, followersGained: 9, leadsGenerated: 0 },
    },
    {
      internalTitle: 'Scheduled — Sales-loop breakdown',
      accountIdx: 0,
      ideaIdx: inProgressIdeas[0] ? ideas.indexOf(inProgressIdeas[0]) : undefined,
      body: 'A 2-person BD desk closed 4 discovery calls last week. Here\'s the (ugly) weekly loop we ran end-to-end.',
      hook: 'A 2-person BD desk closed 4 calls last week — here is the ugly playbook.',
      hashtags: ['SalesOps', 'BD', 'Playbook'],
      format: 'TEXT',
      status: 'SCHEDULED',
      scheduledOffset: 3,
    },
    {
      internalTitle: 'Scheduled — CRM walkthrough video',
      accountIdx: 1,
      body: '90 seconds inside our internal CRM: sales analytics, opportunity pipeline, and the payroll module.',
      hook: 'A 90-second tour of the CRM we built in-house.',
      hashtags: ['ProductTour', 'BuildInPublic'],
      format: 'VIDEO',
      status: 'SCHEDULED',
      scheduledOffset: 11,
    },
    {
      internalTitle: 'Scheduled — Poll on billing models',
      accountIdx: 1,
      body: 'How do you price today? Fixed / T&M / Value / Hybrid.',
      hashtags: ['B2B', 'Pricing'],
      format: 'POLL',
      status: 'SCHEDULED',
      scheduledOffset: 7,
    },
    {
      internalTitle: 'Scheduled — Framework for qualifying AI projects',
      accountIdx: 2,
      body: 'Three questions we run every "cool AI idea" through before quoting. Saves us weeks.',
      hashtags: ['AI', 'Consulting', 'Framework'],
      format: 'DOCUMENT',
      status: 'SCHEDULED',
      scheduledOffset: 10,
    },
    {
      internalTitle: 'Scheduled — Client-onboarding red flags',
      accountIdx: 0,
      body: '5 signals on the discovery call that predict painful engagements.',
      hashtags: ['SalesOps', 'RedFlags'],
      format: 'TEXT',
      status: 'SCHEDULED',
      scheduledOffset: 4,
    },
    {
      internalTitle: 'Scheduled — AI checklist lead magnet',
      accountIdx: 2,
      body: 'Drop "MVP" in the comments and I will send you the AI-delivery checklist we use.',
      firstComment: 'Checklist here: https://sargas.example/ai-checklist',
      hashtags: ['LeadMagnet', 'AI'],
      format: 'TEXT',
      status: 'SCHEDULED',
      scheduledOffset: 14,
    },
    {
      internalTitle: 'Scheduled — behind-the-scenes payroll module',
      accountIdx: 0,
      ideaIdx: inProgressIdeas[1] ? ideas.indexOf(inProgressIdeas[1]) : undefined,
      body: 'We finally shipped the payroll module — spreadsheet retirement party underway.',
      hashtags: ['BuildInPublic', 'Product'],
      format: 'IMAGE',
      status: 'SCHEDULED',
      scheduledOffset: 9,
    },
    {
      internalTitle: 'Ready — CTOs framework recap',
      accountIdx: 1,
      body: 'Ready to ship: full framework recap in carousel format.',
      hashtags: ['CTO', 'Consulting'],
      format: 'DOCUMENT',
      status: 'READY',
    },
    {
      internalTitle: 'Ready — pun-free version of that sales joke',
      accountIdx: 0,
      body: 'A cleaner, punchier retake on that sales tip nobody asked for.',
      hashtags: ['Sales'],
      format: 'TEXT',
      status: 'READY',
    },
    {
      internalTitle: 'Draft — pricing anchor experiment',
      accountIdx: 1,
      body: 'Rough outline: 3 pricing anchors, ask which reads as premium.',
      hashtags: ['Pricing'],
      format: 'POLL',
      status: 'DRAFT',
    },
    {
      internalTitle: 'Draft — quarterly review talk',
      accountIdx: 0,
      body: 'Recap of the quarterly review deck. Needs the metric slides updated.',
      hashtags: ['Ops'],
      format: 'DOCUMENT',
      status: 'DRAFT',
    },
    {
      internalTitle: 'Draft — internal Slackbot rewrite',
      accountIdx: 2,
      body: 'Tech-debt story about killing our internal Slackbot. Needs a code snippet.',
      hashtags: ['Engineering', 'TechDebt'],
      format: 'TEXT',
      status: 'DRAFT',
    },
    {
      internalTitle: 'Archived — old event pitch',
      accountIdx: 1,
      body: 'Monthly LinkedIn Live proposal. Shelved.',
      hashtags: ['Event'],
      format: 'LINK',
      status: 'ARCHIVED',
    },
    {
      internalTitle: 'Published — Sargas culture note',
      accountIdx: 1,
      body: 'A small ritual we run every Friday — and why we haven\'t skipped it in two years.',
      hashtags: ['Culture'],
      format: 'TEXT',
      status: 'PUBLISHED',
      publishedOffset: -30,
      linkedInUrl: 'https://www.linkedin.com/posts/sargas-consulting/friday-ritual',
      metrics: { impressions: 3120, reactions: 76, comments: 11, reposts: 3, clicks: 88, followersGained: 5, leadsGenerated: 0 },
    },
    {
      internalTitle: 'Published — annual review template',
      accountIdx: 1,
      body: 'We\'re open-sourcing our annual client review deck. Steal it.',
      firstComment: 'Deck: https://sargas.example/annual-review',
      hashtags: ['Template', 'AccountManagement'],
      format: 'DOCUMENT',
      status: 'PUBLISHED',
      publishedOffset: -45,
      linkedInUrl: 'https://www.linkedin.com/posts/sargas-consulting/annual-review-template',
      metrics: { impressions: 12800, reactions: 320, comments: 54, reposts: 41, clicks: 780, followersGained: 34, leadsGenerated: 4 },
    },
    // Two posts sharing one Idea (so Idea View shows > 1 related post).
    {
      internalTitle: 'Published — Aurora case study long-form',
      accountIdx: 0,
      ideaIdx: convertedIdeas[0] ? ideas.indexOf(convertedIdeas[0]) : undefined,
      body: 'Personal-voice retelling of the Aurora Systems case study.',
      hashtags: ['ClientStory'],
      format: 'TEXT',
      status: 'PUBLISHED',
      publishedOffset: -4,
      linkedInUrl: 'https://www.linkedin.com/posts/vadim-chervonchenko/aurora-long',
      metrics: { impressions: 7420, reactions: 162, comments: 28, reposts: 12, clicks: 380, followersGained: 14, leadsGenerated: 3 },
    },
  ];

  let postCount = 0;
  for (const p of POST_SEEDS) {
    const author = employees[Math.floor(rng() * employees.length)];
    await prisma.linkedInPost.create({
      data: {
        internalTitle: `${p.internalTitle}${DEMO_LINKEDIN_POST_SUFFIX}`,
        accountId: accounts[p.accountIdx].id,
        ideaId: p.ideaIdx != null ? ideas[p.ideaIdx].id : null,
        authorId: author?.id ?? null,
        body: p.body,
        hook: p.hook ?? null,
        firstComment: p.firstComment ?? null,
        hashtags: p.hashtags,
        format: p.format,
        language: 'en',
        status: p.status,
        scheduledAt:
          p.scheduledOffset != null ? dayOffset(p.scheduledOffset, 9, 30) : null,
        publishedAt:
          p.publishedOffset != null
            ? dayOffset(p.publishedOffset, 8 + Math.floor(rng() * 6), 0)
            : null,
        linkedInUrl: p.linkedInUrl ?? null,
        impressions: p.metrics?.impressions ?? 0,
        reactions: p.metrics?.reactions ?? 0,
        comments: p.metrics?.comments ?? 0,
        reposts: p.metrics?.reposts ?? 0,
        clicks: p.metrics?.clicks ?? 0,
        followersGained: p.metrics?.followersGained ?? 0,
        leadsGenerated: p.metrics?.leadsGenerated ?? 0,
      },
    });
    postCount++;
  }

  // ─── Calendar density fillers ────────────────────────────────
  // Spread a bunch of published + scheduled posts across the current
  // and neighbour months so the calendar view is visually alive.
  const FORMATS: Array<'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LINK' | 'POLL'> = [
    'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LINK', 'POLL',
  ];
  const HASHTAG_POOL = [
    'SalesOps', 'AI', 'RevOps', 'BuildInPublic', 'Founders',
    'ClientStory', 'Culture', 'Hiring', 'Product', 'Consulting',
    'RemoteWork', 'B2B', 'Framework', 'Poll', 'Retro',
  ];

  const filler: Array<{
    title: string;
    offsetPub?: number;
    offsetSched?: number;
    status: 'PUBLISHED' | 'SCHEDULED' | 'DRAFT' | 'READY';
  }> = [
    // Past — published, dense across current month.
    { title: 'Weekly ops recap', offsetPub: -1, status: 'PUBLISHED' },
    { title: 'AI carousel drop', offsetPub: -2, status: 'PUBLISHED' },
    { title: 'Client win — Nordic Retail', offsetPub: -3, status: 'PUBLISHED' },
    { title: 'Sunday reflections', offsetPub: -5, status: 'PUBLISHED' },
    { title: 'Behind-the-scenes team offsite', offsetPub: -7, status: 'PUBLISHED' },
    { title: 'Sales-cycle metrics recap', offsetPub: -8, status: 'PUBLISHED' },
    { title: 'Hot take: pricing anchors', offsetPub: -10, status: 'PUBLISHED' },
    { title: 'Culture note — Friday ritual v2', offsetPub: -12, status: 'PUBLISHED' },
    { title: 'AI proposal wins vs baseline', offsetPub: -13, status: 'PUBLISHED' },
    { title: 'How we hire without job boards', offsetPub: -17, status: 'PUBLISHED' },
    { title: 'Case study — Meridian Logistics', offsetPub: -19, status: 'PUBLISHED' },
    { title: 'Retro — bad projects we killed', offsetPub: -22, status: 'PUBLISHED' },
    { title: 'CTO checklist for new engagements', offsetPub: -24, status: 'PUBLISHED' },
    { title: 'Cold outbound — real reply rates', offsetPub: -26, status: 'PUBLISHED' },
    // A couple of same-day posts to test the "+N more" badge.
    { title: 'Extra thought — pricing again', offsetPub: -2, status: 'PUBLISHED' },
    { title: 'Same day — reply-guy energy', offsetPub: -2, status: 'PUBLISHED' },
    { title: 'Same day — quick tip', offsetPub: -1, status: 'PUBLISHED' },

    // Future — scheduled, dense in next 30 days.
    { title: 'Scheduled — sales-ops checklist', offsetSched: 1, status: 'SCHEDULED' },
    { title: 'Scheduled — hiring push #2', offsetSched: 2, status: 'SCHEDULED' },
    { title: 'Scheduled — client-onboarding red flags v2', offsetSched: 5, status: 'SCHEDULED' },
    { title: 'Scheduled — carousel on AI economics', offsetSched: 6, status: 'SCHEDULED' },
    { title: 'Scheduled — video walkthrough of CRM v2', offsetSched: 8, status: 'SCHEDULED' },
    { title: 'Scheduled — Nordic Retail highlights', offsetSched: 12, status: 'SCHEDULED' },
    { title: 'Scheduled — poll on time-tracking tools', offsetSched: 15, status: 'SCHEDULED' },
    { title: 'Scheduled — culture note', offsetSched: 16, status: 'SCHEDULED' },
    { title: 'Scheduled — case study preview', offsetSched: 18, status: 'SCHEDULED' },
    { title: 'Scheduled — sales-ops podcast plug', offsetSched: 20, status: 'SCHEDULED' },
    { title: 'Scheduled — same day promo', offsetSched: 6, status: 'SCHEDULED' },
    { title: 'Scheduled — quick reminder', offsetSched: 12, status: 'SCHEDULED' },
    // Some in the far future (next month +30) to make the calendar
    // navigation useful.
    { title: 'Scheduled — Q4 retro', offsetSched: 33, status: 'SCHEDULED' },
    { title: 'Scheduled — Holiday season preview', offsetSched: 38, status: 'SCHEDULED' },
  ];

  for (const f of filler) {
    const acc = accounts[Math.floor(rng() * accounts.length)];
    const fmt = FORMATS[Math.floor(rng() * FORMATS.length)];
    const author = employees[Math.floor(rng() * employees.length)];
    const isPublished = f.status === 'PUBLISHED';
    const tags = Array.from({ length: 1 + Math.floor(rng() * 3) }, () =>
      HASHTAG_POOL[Math.floor(rng() * HASHTAG_POOL.length)],
    );

    await prisma.linkedInPost.create({
      data: {
        internalTitle: `${f.title}${DEMO_LINKEDIN_POST_SUFFIX}`,
        accountId: acc.id,
        ideaId: null,
        authorId: author?.id ?? null,
        body: `${f.title}. Auto-generated demo body for the calendar density filler.`,
        hashtags: Array.from(new Set(tags)),
        format: fmt,
        language: 'en',
        status: f.status,
        scheduledAt:
          f.offsetSched != null ? dayOffset(f.offsetSched, 9 + Math.floor(rng() * 6), 30) : null,
        publishedAt:
          f.offsetPub != null ? dayOffset(f.offsetPub, 8 + Math.floor(rng() * 8), 15) : null,
        linkedInUrl: isPublished
          ? `https://www.linkedin.com/posts/sargas-consulting/demo-${postCount}`
          : null,
        impressions: isPublished ? 500 + Math.floor(rng() * 8000) : 0,
        reactions: isPublished ? 10 + Math.floor(rng() * 200) : 0,
        comments: isPublished ? Math.floor(rng() * 40) : 0,
        reposts: isPublished ? Math.floor(rng() * 20) : 0,
        clicks: isPublished ? Math.floor(rng() * 400) : 0,
        followersGained: isPublished ? Math.floor(rng() * 20) : 0,
        leadsGenerated: isPublished ? Math.floor(rng() * 5) : 0,
      },
    });
    postCount++;
  }

  return { accountCount: accounts.length, ideaCount: ideas.length, postCount };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
