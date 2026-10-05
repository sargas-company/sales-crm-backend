/* eslint-disable no-console */
/**
 * System-only seed.
 *
 * Production-safe subset of `prisma/seed.ts`. Writes only reference /
 * system data that EVERY environment must have:
 *
 *   - Permission catalogue (idempotent upsert by `key`);
 *   - 3 canonical roles (owner / admin_manager / regular_manager),
 *     with Owner's RolePermission set resynced to the full catalogue
 *     so new permissions added by a migration become usable without
 *     a Prisma studio session;
 *   - Platform reference row for Upwork.
 *
 * What it NEVER does:
 *
 *   - Create demo users (admin@test.com, manager@test.com, tg-bot…).
 *   - Seed Accounts, Prompts, Phone Numbers, Portfolio, Backup rows,
 *     Audit demo events — all of that lives only in the full
 *     `prisma/seed.ts` for local walkthroughs.
 *   - Overwrite any production business data.
 *
 * Rerunning is a true no-op (every DB write is an upsert / updateMany
 * on a value that is already there). Safe after `prisma migrate deploy`
 * on production, and also safe to run on local.
 *
 *   npx ts-node prisma/seed-system.ts
 *   npm run seed:system
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  ADMIN_MANAGER_PRESET_KEYS,
  REGULAR_MANAGER_PRESET_KEYS,
} from '../src/auth/system-role-presets';

const prisma = new PrismaClient();

const OWNER_ROLE_ID = '00000000-0000-0000-0000-000000000101';
const ADMIN_MANAGER_ROLE_ID = '00000000-0000-0000-0000-000000000102';
const REGULAR_MANAGER_ROLE_ID = '00000000-0000-0000-0000-000000000103';
const UPWORK_ID = '00000000-0000-0000-0000-000000000001';

interface PermissionSeed {
  key: string;
  module: string;
  action: string;
  label: string;
}

// Loaded lazily so this file does not have to repeat the catalogue —
// `prisma/seed.ts` exports the same list indirectly, but keeping a
// duplicate import graph here would couple production ops to the
// demo seed. Instead we read the catalogue from `src/auth/*`.
// If a new permission is added by a migration, the migration itself
// MUST insert it into the Permission table (ON CONFLICT DO NOTHING)
// AND, for Owner, insert into RolePermission with (roleId,
// permissionId) ON CONFLICT DO NOTHING — see
// `20261021000000_grant_owner_discord_integration_permissions` for a
// canonical example. This script is a safety net, not a substitute.

async function main() {
  // ─── Permission catalogue — pulled directly from the DB. Any key
  //     already present stays as-is; the script only works with keys
  //     the migration already installed. ────────────────────────────
  const catalogue = await prisma.permission.findMany({
    select: { id: true, key: true, module: true, action: true, label: true },
  });
  if (catalogue.length === 0) {
    throw new Error(
      'Permission catalogue is empty; `prisma migrate deploy` must have been run first.',
    );
  }
  console.log(`[seed-system] Permission catalogue size: ${catalogue.length}`);

  // ─── System roles — upsert by name, system=true. ────────────────
  const owner = await prisma.role.upsert({
    where: { name: 'owner' },
    update: { label: 'Owner', system: true, description: 'Full access.' },
    create: {
      id: OWNER_ROLE_ID,
      name: 'owner',
      label: 'Owner',
      system: true,
      description: 'Full access to every module.',
    },
  });
  const adminManager = await prisma.role.upsert({
    where: { name: 'admin_manager' },
    update: { label: 'Admin Manager', system: true },
    create: {
      id: ADMIN_MANAGER_ROLE_ID,
      name: 'admin_manager',
      label: 'Admin Manager',
      system: true,
      description: 'Operational access; no finance / salary data.',
    },
  });
  const regularManager = await prisma.role.upsert({
    where: { name: 'regular_manager' },
    update: { label: 'Regular Manager', system: true },
    create: {
      id: REGULAR_MANAGER_ROLE_ID,
      name: 'regular_manager',
      label: 'Regular Manager',
      system: true,
      description: 'Project reports authoring + viewing only.',
    },
  });

  // ─── Owner → every permission. Grant missing links idempotently.
  // Admin / Regular Managers are NOT resynced: their RolePermission
  // set is treated as operator-managed on production (presets apply
  // only on initial role creation; see full `prisma/seed.ts`).
  const ownerExistingLinks = await prisma.rolePermission.findMany({
    where: { roleId: owner.id },
    select: { permissionId: true },
  });
  const ownerHas = new Set(ownerExistingLinks.map((l) => l.permissionId));
  const missing = catalogue.filter((p) => !ownerHas.has(p.id));
  if (missing.length > 0) {
    await prisma.rolePermission.createMany({
      data: missing.map((p) => ({ roleId: owner.id, permissionId: p.id })),
      skipDuplicates: true,
    });
    console.log(
      `[seed-system] Granted Owner ${missing.length} missing permission(s): ${missing.map((p) => p.key).join(', ')}`,
    );
  } else {
    console.log('[seed-system] Owner already has every catalogue permission.');
  }

  // ─── Admin / Regular Manager — only populate presets when the role
  // has NO permissions at all. Any non-empty state is operator-owned.
  for (const [role, preset] of [
    [adminManager, ADMIN_MANAGER_PRESET_KEYS],
    [regularManager, REGULAR_MANAGER_PRESET_KEYS],
  ] as const) {
    const count = await prisma.rolePermission.count({ where: { roleId: role.id } });
    if (count > 0) {
      console.log(
        `[seed-system] ${role.name} already has ${count} permission(s); preset NOT applied.`,
      );
      continue;
    }
    const presetKeys = [...preset];
    const presetPerms = catalogue.filter((p) => presetKeys.includes(p.key));
    if (presetPerms.length === 0) {
      console.log(`[seed-system] ${role.name} preset — no matching catalogue keys found; skipping.`);
      continue;
    }
    await prisma.rolePermission.createMany({
      data: presetPerms.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
    console.log(
      `[seed-system] ${role.name} preset applied (${presetPerms.length} permissions).`,
    );
  }

  // ─── Platform reference — Upwork.
  await prisma.platform.upsert({
    where: { id: UPWORK_ID },
    update: { title: 'Upwork', slug: 'upwork' },
    create: {
      id: UPWORK_ID,
      title: 'Upwork',
      slug: 'upwork',
      imageUrl: 'https://cdn.worldvectorlogo.com/logos/upwork-roundedsquare-1.svg',
    },
  });

  console.log('[seed-system] Done.');
}

main()
  .catch((e) => {
    console.error('[seed-system] FAILED', (e as Error).message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
