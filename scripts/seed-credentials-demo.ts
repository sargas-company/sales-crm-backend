/**
 * Credentials vault demo seed. Idempotent: re-running does not duplicate
 * profiles or accounts; existing user-created rows are left untouched.
 *
 * Writes three profiles — Vadym (PERSON linked to Employee), Sarah
 * (PERSON, unlinked), Sargas Agency (COMPANY) — plus a handful of
 * accounts across common services, two attachments, and a seeded
 * AuditEvent trail.
 *
 * Requires CREDENTIAL_VAULT_MASTER_KEY_V1 in env — the script bails
 * early with a clear message if it is missing, so it can't silently
 * run and produce unreadable rows.
 *
 * Usage:
 *   npx ts-node scripts/seed-credentials-demo.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import {
  AuditResult,
  CredentialAccountStatus,
  CredentialProfileStatus,
  CredentialProfileType,
  PrismaClient,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { CredentialEncryptionService } from '../src/credentials-vault/encryption.service';

const prisma = new PrismaClient();

if (!process.env.CREDENTIAL_VAULT_MASTER_KEY_V1) {
  console.error(
    '❌  CREDENTIAL_VAULT_MASTER_KEY_V1 missing — generate one with `openssl rand -base64 32` and add to .env.',
  );
  process.exit(1);
}

const enc = new CredentialEncryptionService(new ConfigService());

interface SeedProfile {
  slug: string;
  name: string;
  type: CredentialProfileType;
  description: string;
  tags: string[];
  employeeEmail?: string;
  accounts: SeedAccount[];
}

interface SeedAccount {
  serviceName: string;
  category: string;
  serviceUrl: string;
  usernameHint: string;
  tags: string[];
  secrets: Record<string, unknown>;
}

const DEMO_PROFILES: SeedProfile[] = [
  {
    slug: 'vadym',
    name: 'Vadym',
    type: 'PERSON',
    description: 'Owner · founder credentials.',
    tags: ['owner', 'founder'],
    employeeEmail: 'vadim.chervonchenko@gmail.com',
    accounts: [
      {
        serviceName: 'Upwork',
        category: 'Platform',
        serviceUrl: 'https://www.upwork.com',
        usernameHint: 'va***@gmail.com',
        tags: ['sales', 'leads'],
        secrets: {
          username: 'vadym.sargas',
          email: 'vadym@sargas.co',
          password: 'DemoUpworkP@ss_2026!',
          totpSeed: 'JBSWY3DPEHPK3PXP',
          recoveryCodes: [
            'abcd-efgh-ijkl',
            'mnop-qrst-uvwx',
            '1234-5678-90ab',
          ],
          secureNote: 'Primary agency account. Rotate every 90 days.',
        },
      },
      {
        serviceName: 'Gmail',
        category: 'Email',
        serviceUrl: 'https://mail.google.com',
        usernameHint: 'va***@sargas.co',
        tags: ['founder'],
        secrets: {
          email: 'vadym@sargas.co',
          password: 'G0ogle!M@il_demo',
          totpSeed: 'KRUGS3DOEBWW64TB',
          customFields: [
            { label: 'App password · Thunderbird', value: 'xxxx yyyy zzzz 1111' },
          ],
        },
      },
      {
        serviceName: 'LinkedIn',
        category: 'Social',
        serviceUrl: 'https://www.linkedin.com',
        usernameHint: 'va***@sargas.co',
        tags: ['content', 'brand'],
        secrets: {
          email: 'vadym@sargas.co',
          password: 'LinkedIn-demo-99',
          pin: '4821',
        },
      },
    ],
  },
  {
    slug: 'sarah',
    name: 'Sarah',
    type: 'PERSON',
    description: 'External sales operator (contractor, no Employee record).',
    tags: ['contractor', 'sales'],
    accounts: [
      {
        serviceName: 'Upwork',
        category: 'Platform',
        serviceUrl: 'https://www.upwork.com',
        usernameHint: 'sa***@gmail.com',
        tags: ['sales'],
        secrets: {
          username: 'sarah.ops',
          email: 'sarah@sargas.co',
          password: 'SarahDemoPass_123',
          totpSeed: 'JBSWY3DPEHPK3PXR',
          recoveryCodes: ['a1b2-c3d4-e5f6'],
        },
      },
      {
        serviceName: 'Slack · Partners workspace',
        category: 'Communication',
        serviceUrl: 'https://partners.slack.com',
        usernameHint: 'sa***@sargas.co',
        tags: [],
        secrets: {
          email: 'sarah@sargas.co',
          password: 'SlackPartners_demo',
          secureNote: 'Guest access expires end of month.',
        },
      },
    ],
  },
  {
    slug: 'sargas-agency',
    name: 'Sargas Agency',
    type: 'COMPANY',
    description: 'Shared agency-level logins (ops, billing, DNS).',
    tags: ['company', 'shared'],
    accounts: [
      {
        serviceName: 'Stripe',
        category: 'Billing',
        serviceUrl: 'https://dashboard.stripe.com',
        usernameHint: 'bil***@sargas.co',
        tags: ['billing'],
        secrets: {
          email: 'billing@sargas.co',
          password: 'Str1pe-demo-key',
          totpSeed: 'KBSWY3DPEHPK3PXP',
          recoveryCodes: [
            'z9y8-x7w6-v5u4',
            't3s2-r1q0-p9o8',
            'n7m6-l5k4-j3i2',
          ],
          secureNote: 'DO NOT share. Owner + Admin Manager only.',
          customFields: [
            {
              label: 'Signing key (webhooks)',
              value: 'whsec_demo_1234567890abcdef',
            },
          ],
        },
      },
      {
        serviceName: 'Cloudflare',
        category: 'DNS',
        serviceUrl: 'https://dash.cloudflare.com',
        usernameHint: 'op***@sargas.co',
        tags: ['infra'],
        secrets: {
          email: 'ops@sargas.co',
          password: 'CloudflareDemo_55',
          totpSeed: 'MBSWY3DPEHPK3PXP',
          secureNote: 'Zone edit permission.',
        },
      },
    ],
  },
];

async function main() {
  console.log('seed:credentials — demo profiles + accounts + audit');
  const [owner, adminManager] = await Promise.all([
    prisma.user.findFirst({ where: { roleRef: { name: 'owner' } }, select: { id: true, email: true } }),
    prisma.user.findFirst({ where: { roleRef: { name: 'admin_manager' } }, select: { id: true, email: true } }),
  ]);
  const actor = owner ?? adminManager ?? null;
  if (!actor) {
    console.warn(
      '⚠️  No Owner or Admin Manager user found — seeding without a createdBy actor.',
    );
  }

  for (const p of DEMO_PROFILES) {
    const employee = p.employeeEmail
      ? await prisma.employee.findUnique({
          where: { email: p.employeeEmail },
          select: { id: true },
        })
      : null;

    const existing = await prisma.credentialProfile.findUnique({
      where: { slug: p.slug },
      select: { id: true },
    });

    const profile = existing
      ? existing
      : await prisma.credentialProfile.create({
          data: {
            slug: p.slug,
            name: p.name,
            type: p.type,
            description: p.description,
            tags: p.tags,
            status: CredentialProfileStatus.ACTIVE,
            employeeId: employee?.id ?? null,
            createdById: actor?.id ?? null,
            updatedById: actor?.id ?? null,
          },
          select: { id: true },
        });

    for (const a of p.accounts) {
      const existingAccount = await prisma.credentialAccount.findFirst({
        where: { profileId: profile.id, serviceName: a.serviceName },
        select: { id: true },
      });
      if (existingAccount) continue;
      const enveloped = enc.encryptJson(a.secrets);
      await prisma.credentialAccount.create({
        data: {
          profileId: profile.id,
          serviceName: a.serviceName,
          category: a.category,
          serviceUrl: a.serviceUrl,
          tags: a.tags,
          usernameHint: a.usernameHint,
          status: CredentialAccountStatus.ACTIVE,
          encPayload: enveloped.ciphertext,
          encIv: enveloped.iv,
          encAuthTag: enveloped.authTag,
          encKeyVersion: enveloped.keyVersion,
          encAlgorithm: enveloped.algorithm,
          lastRotatedAt: new Date(),
          createdById: actor?.id ?? null,
          updatedById: actor?.id ?? null,
        },
      });
    }

    // Attach one small demo attachment per profile — a text note so we
    // exercise the encrypted-blob codepath without external file deps.
    const attachmentCount = await prisma.credentialAttachment.count({
      where: { account: { profileId: profile.id } },
    });
    if (attachmentCount === 0) {
      const anyAccount = await prisma.credentialAccount.findFirst({
        where: { profileId: profile.id },
        select: { id: true },
      });
      if (anyAccount) {
        const noteBuffer = Buffer.from(
          `Demo attachment for ${p.name} — this file is encrypted at rest.`,
          'utf8',
        );
        const meta = enc.encryptJson({
          filename: `${p.slug}-demo.txt`,
          mime: 'text/plain',
        });
        const content = enc.encryptBuffer(noteBuffer);
        await prisma.credentialAttachment.create({
          data: {
            accountId: anyAccount.id,
            encMeta: meta.ciphertext,
            encMetaIv: meta.iv,
            encMetaAuthTag: meta.authTag,
            encContent: content.ciphertext,
            encContentIv: content.iv,
            encContentAuthTag: content.authTag,
            encKeyVersion: content.keyVersion,
            encAlgorithm: content.algorithm,
            size: noteBuffer.length,
            uploadedById: actor?.id ?? null,
          },
        });
      }
    }
  }

  const existingAudit = await prisma.auditEvent.findFirst({
    where: { domain: 'credentials', action: 'seed.demo' },
    select: { id: true },
  });
  if (!existingAudit && actor) {
    await prisma.auditEvent.create({
      data: {
        actorUserId: actor.id,
        domain: 'credentials',
        action: 'seed.demo',
        targetType: 'System',
        targetLabel: 'Credentials demo seed',
        result: AuditResult.SUCCESS,
        metadata: {
          profiles: DEMO_PROFILES.map((p) => p.slug),
        },
      },
    });
  }

  const totals = await Promise.all([
    prisma.credentialProfile.count(),
    prisma.credentialAccount.count(),
    prisma.credentialAttachment.count(),
    prisma.auditEvent.count({ where: { domain: 'credentials' } }),
  ]);
  console.log(
    `✓ seed:credentials complete · profiles=${totals[0]}, accounts=${totals[1]}, attachments=${totals[2]}, audit=${totals[3]}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
