/* eslint-disable no-console */
/**
 * Local-only demo seed. Idempotent via deterministic UUID v5 ids
 * derived from a fixed namespace + a human-readable key, so a re-run
 * updates existing rows instead of creating duplicates. The script
 * refuses to run when APP_ENV=production.
 *
 * Usage:
 *   APP_ENV=local npx ts-node -r tsconfig-paths/register scripts/seed-demo.ts
 *
 * Deliberately not wired into prisma seed, Make, or any CI path.
 */
import { PrismaClient, LeadStatus, LeadTemperature, ClientStatus, ClientCallClientType } from '@prisma/client';
import { createHash } from 'crypto';

/** UUID v5-style deterministic id from (namespace, name). Not strict
 *  RFC v5 but stable + collision-free for the demo keyspace. */
const DEMO_NS = 'sargas-crm-demo-ns-2026-10';
const idOf = (kind: string, slug: string): string => {
  const h = createHash('sha1').update(`${DEMO_NS}|${kind}|${slug}`).digest('hex');
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-` +
    `${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${h.slice(18, 20)}-` +
    `${h.slice(20, 32)}`
  );
};

const APP_ENV = process.env.APP_ENV ?? '';
if (APP_ENV === 'production') {
  console.error('seed-demo refuses to run with APP_ENV=production');
  process.exit(2);
}

const prisma = new PrismaClient();

const LEAD_STATUSES: LeadStatus[] = ['NEW', 'CONTACTED', 'IN_CONVERSATION', 'ON_HOLD', 'WON', 'LOST'];
const TEMPERATURES: (LeadTemperature | null)[] = ['COLD', 'WARM', 'HOT', null];
const SOURCES = ['Upwork', 'LinkedIn', 'Referral', 'Website', 'Cold outreach'];
const CLIENT_STATUSES: ClientStatus[] = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ON_HOLD', 'FORMER'];
const INTL_PHONES = [
  '+14155550123', '+442071234567', '+380971234567', '+819012345678',
  '+5511987654321', '+34612345678', '+4915112345678', '+972501234567',
  '+61412345678', '+13235550199', null, null,
];

async function seedLeads() {
  const leads: { id: string; slug: string }[] = [];
  for (let i = 1; i <= 20; i++) {
    const slug = `lead-${String(i).padStart(2, '0')}`;
    const id = idOf('lead', slug);
    const status = LEAD_STATUSES[i % LEAD_STATUSES.length];
    const temperature = TEMPERATURES[i % TEMPERATURES.length];
    const source = SOURCES[i % SOURCES.length];
    const emailShown = i % 4 !== 0;
    const phoneShown = i % 3 !== 0;
    const profileShown = i % 5 !== 0;
    const notesShown = i % 2 === 0;
    await prisma.lead.upsert({
      where: { id },
      update: {
        firstName: `DemoFirst${i}`,
        lastName: `DemoLast${i}`,
        companyName: i % 3 === 0 ? `Demo Co ${i}` : null,
        email: emailShown ? `demo${i}@example.test` : null,
        phone: phoneShown ? INTL_PHONES[i % INTL_PHONES.length] : null,
        source,
        profileUrl: profileShown ? `https://example.test/profile/${slug}` : null,
        temperature,
        notes: notesShown ? `Demo note #${i} — follow-up queued.` : null,
        status,
        rate: 50 + (i % 7) * 10,
        location: ['United States', 'Ukraine', 'Germany', 'Brazil', 'Israel'][i % 5],
      },
      create: {
        id,
        firstName: `DemoFirst${i}`,
        lastName: `DemoLast${i}`,
        companyName: i % 3 === 0 ? `Demo Co ${i}` : null,
        email: emailShown ? `demo${i}@example.test` : null,
        phone: phoneShown ? INTL_PHONES[i % INTL_PHONES.length] : null,
        source,
        profileUrl: profileShown ? `https://example.test/profile/${slug}` : null,
        temperature,
        notes: notesShown ? `Demo note #${i} — follow-up queued.` : null,
        status,
        rate: 50 + (i % 7) * 10,
        location: ['United States', 'Ukraine', 'Germany', 'Brazil', 'Israel'][i % 5],
      },
    });
    leads.push({ id, slug });
  }
  return leads;
}

async function seedClients() {
  const clients: { id: string; slug: string }[] = [];
  for (let i = 1; i <= 12; i++) {
    const slug = `client-${String(i).padStart(2, '0')}`;
    const id = idOf('client', slug);
    const status = CLIENT_STATUSES[i % CLIENT_STATUSES.length];
    const source = SOURCES[i % SOURCES.length];
    const emailShown = i % 4 !== 0;
    const phoneShown = i % 3 !== 0;
    const sinceShown = i % 2 === 0;
    const profileShown = i % 5 !== 0;
    const notesShown = i % 3 !== 0;
    await prisma.client.upsert({
      where: { id },
      update: {
        firstName: `DemoClientFirst${i}`,
        lastName: i % 7 === 0 ? null : `DemoClientLast${i}`,
        company: i % 2 === 0 ? `Example Corp ${i}` : null,
        email: emailShown ? `client${i}@example.test` : null,
        phone: phoneShown ? INTL_PHONES[(i * 3) % INTL_PHONES.length] : null,
        source,
        profileUrl: profileShown ? `https://example.test/clients/${slug}` : null,
        status,
        clientSince: sinceShown ? new Date(2024, i % 12, 1 + (i % 27)) : null,
        notes: notesShown ? `Demo client note ${i}. Account manager: TBD.` : null,
      },
      create: {
        id,
        firstName: `DemoClientFirst${i}`,
        lastName: i % 7 === 0 ? null : `DemoClientLast${i}`,
        company: i % 2 === 0 ? `Example Corp ${i}` : null,
        email: emailShown ? `client${i}@example.test` : null,
        phone: phoneShown ? INTL_PHONES[(i * 3) % INTL_PHONES.length] : null,
        source,
        profileUrl: profileShown ? `https://example.test/clients/${slug}` : null,
        status,
        clientSince: sinceShown ? new Date(2024, i % 12, 1 + (i % 27)) : null,
        notes: notesShown ? `Demo client note ${i}. Account manager: TBD.` : null,
      },
    });
    clients.push({ id, slug });
  }
  return clients;
}

async function seedCalls(
  leads: { id: string; slug: string }[],
  clients: { id: string; slug: string }[],
) {
  const createdBy = await prisma.user.findFirst({ select: { id: true } });
  if (!createdBy) {
    console.warn('[seed-demo] no user in DB — skipping ClientCall seed');
    return;
  }
  const cr = await prisma.clientRequest.findFirst({ select: { id: true } });

  const specs: Array<{
    slug: string;
    clientType: ClientCallClientType;
    leadId?: string;
    crmClientId?: string;
    clientRequestId?: string;
    title: string;
  }> = [
    { slug: 'call-lead-01', clientType: 'lead', leadId: leads[0].id, title: 'Discovery with Lead #1' },
    { slug: 'call-lead-02', clientType: 'lead', leadId: leads[3].id, title: 'Follow-up with Lead #4' },
    { slug: 'call-client-01', clientType: 'client', crmClientId: clients[0].id, title: 'QBR — Client #1' },
    { slug: 'call-client-02', clientType: 'client', crmClientId: clients[5].id, title: 'Status sync — Client #6' },
  ];
  if (cr) {
    specs.push({
      slug: 'call-cr-01',
      clientType: 'client_request',
      clientRequestId: cr.id,
      title: 'Public inquiry — intro call',
    });
  }

  for (const s of specs) {
    const id = idOf('call', s.slug);
    const data = {
      clientType: s.clientType,
      leadId: s.leadId ?? null,
      crmClientId: s.crmClientId ?? null,
      clientRequestId: s.clientRequestId ?? null,
      callTitle: s.title,
      scheduledAt: new Date(Date.now() + 86_400_000 * (specs.indexOf(s) + 1)),
      clientTimezone: 'Europe/Kiev',
      duration: 30,
      createdById: createdBy.id,
    };
    await prisma.clientCall.upsert({
      where: { id },
      update: data,
      create: { id, ...data },
    });
  }
}

async function wireProjectsToClients(clients: { id: string; slug: string }[]) {
  // Link up to 3 existing projects (lowest createdAt first) to the
  // first demo clients, leaving older ones with crmClientId=null to
  // exercise the "legacy / unlinked" code path.
  const existing = await prisma.project.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, crmClientId: true },
    take: 3,
  });
  for (let i = 0; i < existing.length; i++) {
    if (existing[i].crmClientId) continue;
    await prisma.project.update({
      where: { id: existing[i].id },
      data: { crmClientId: clients[i].id },
    });
  }
}

async function main() {
  console.log('[seed-demo] starting (APP_ENV=%s)', APP_ENV || '<unset>');
  const leads = await seedLeads();
  const clients = await seedClients();
  await seedCalls(leads, clients);
  await wireProjectsToClients(clients);

  const [leadCount, clientCount, callCount] = await Promise.all([
    prisma.lead.count(),
    prisma.client.count(),
    prisma.clientCall.count(),
  ]);
  const projectsWithCrmClient = await prisma.project.count({
    where: { crmClientId: { not: null } },
  });
  console.log('[seed-demo] done');
  console.log(JSON.stringify({ leadCount, clientCount, callCount, projectsWithCrmClient }, null, 2));
}

main()
  .catch((e) => {
    console.error('[seed-demo] failed', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
