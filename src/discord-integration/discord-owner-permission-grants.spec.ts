/**
 * Regression against the root cause of the "Could not load Discord
 * profiles" screen: `discord_integration:*` existed in the Permission
 * catalogue but was never linked to the Owner role in RolePermission.
 *
 * Integration test — reads the live local Postgres. Verifies:
 *   - owner has all four discord_integration:* keys;
 *   - admin_manager has none of them (ADMIN_FORBIDDEN contract);
 *   - regular_manager has none of them (REGULAR_FORBIDDEN contract).
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DISCORD_KEYS = [
  'discord_integration:view',
  'discord_integration:configure',
  'discord_integration:send_test',
  'discord_integration:activate_profile',
];

async function keysForRole(role: string): Promise<Set<string>> {
  const rows = await prisma.rolePermission.findMany({
    where: { role: { name: role } },
    select: { permission: { select: { key: true } } },
  });
  return new Set(rows.map((r) => r.permission.key));
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('discord_integration:* grants in RolePermission', () => {
  it('owner has all four discord_integration keys', async () => {
    const owned = await keysForRole('owner');
    const missing = DISCORD_KEYS.filter((k) => !owned.has(k));
    expect(missing).toEqual([]);
  });

  it('admin_manager has none of the discord_integration keys', async () => {
    const owned = await keysForRole('admin_manager');
    const leaked = DISCORD_KEYS.filter((k) => owned.has(k));
    expect(leaked).toEqual([]);
  });

  it('regular_manager has none of the discord_integration keys', async () => {
    const owned = await keysForRole('regular_manager');
    const leaked = DISCORD_KEYS.filter((k) => owned.has(k));
    expect(leaked).toEqual([]);
  });
});
