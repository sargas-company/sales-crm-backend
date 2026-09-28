import { describe, it, expect, beforeEach } from '@jest/globals';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { RolesService } from './roles.service';

// Fully-mocked unit tests for the RBAC invariants documented in the
// roles service. No DB, no HTTP; every Prisma call is stubbed per test.

type Overrides = {
  user?: Partial<{
    findUnique: (args: unknown) => Promise<unknown>;
    count: (args: unknown) => Promise<number>;
    update: (args: unknown) => Promise<unknown>;
  }>;
  role?: Partial<{
    findUnique: (args: unknown) => Promise<unknown>;
    delete: (args: unknown) => Promise<unknown>;
    findUniqueOrThrow: (args: unknown) => Promise<unknown>;
  }>;
};

const makePrisma = (o: Overrides = {}): PrismaService =>
  ({
    user: {
      findUnique: async () => null,
      count: async () => 0,
      update: async () => ({}),
      ...(o.user ?? {}),
    },
    role: {
      findUnique: async () => null,
      delete: async () => ({}),
      findUniqueOrThrow: async () => ({}),
      ...(o.role ?? {}),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    permission: { findMany: async () => [] },
    rolePermission: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
  }) as unknown as PrismaService;

const noopAudit: AuditLogService = {
  log: async () => undefined,
} as unknown as AuditLogService;

describe('RolesService — Owner + system invariants', () => {
  let svc: RolesService;

  const buildSvc = (o: Overrides = {}) => {
    svc = new RolesService(makePrisma(o), noopAudit);
  };

  beforeEach(() => buildSvc());

  it('deleteRole: SYSTEM_ROLE_UNDELETABLE for system roles', async () => {
    buildSvc({
      role: {
        findUnique: async () => ({
          id: 'r1',
          name: 'owner',
          label: 'Owner',
          system: true,
          _count: { users: 0 },
        }),
      },
    });
    await expect(svc.deleteRole('r1', 'actor')).rejects.toMatchObject({
      response: { message: 'SYSTEM_ROLE_UNDELETABLE' },
    });
  });

  it('deleteRole: ROLE_HAS_USERS when custom role has assigned users', async () => {
    buildSvc({
      role: {
        findUnique: async () => ({
          id: 'r2',
          name: 'sales',
          label: 'Sales',
          system: false,
          _count: { users: 3 },
        }),
      },
    });
    await expect(svc.deleteRole('r2', 'actor')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('updateRole: SYSTEM_ROLE_SLUG_LOCKED when slug is being changed', async () => {
    buildSvc({
      role: {
        findUnique: async () => ({
          id: 'r1',
          name: 'owner',
          label: 'Owner',
          description: null,
          system: true,
          permissions: [],
        }),
      },
    });
    await expect(
      svc.updateRole('r1', { name: 'not-owner' } as never, 'actor'),
    ).rejects.toMatchObject({ response: { message: 'SYSTEM_ROLE_SLUG_LOCKED' } });
  });

  it('updateRole: OWNER_PERMISSIONS_LOCKED when Owner permission set is edited', async () => {
    buildSvc({
      role: {
        findUnique: async () => ({
          id: 'r1',
          name: 'owner',
          label: 'Owner',
          description: null,
          system: true,
          permissions: [],
        }),
      },
    });
    await expect(
      svc.updateRole(
        'r1',
        { permissionKeys: ['leads:view'] } as never,
        'actor',
      ),
    ).rejects.toMatchObject({
      response: { message: 'OWNER_PERMISSIONS_LOCKED' },
    });
  });

  it('assignRoleToUser: ONLY_OWNER_CAN_GRANT_OWNER when actor is not Owner', async () => {
    buildSvc({
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id === 'targetUser') {
            return {
              id: 'targetUser',
              email: 't@t',
              roleId: 'currentRole',
              roleRef: { name: 'admin_manager' },
            };
          }
          if (where.id === 'actor') {
            return { id: 'actor', roleRef: { name: 'admin_manager' } };
          }
          return null;
        },
      },
      role: {
        findUnique: async () => ({ id: 'ownerRole', name: 'owner' }),
      },
    });
    await expect(
      svc.assignRoleToUser('targetUser', 'ownerRole', 'actor'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assignRoleToUser: LAST_OWNER_LOCK when moving the sole Owner off owner', async () => {
    buildSvc({
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id === 'ownerUser') {
            return {
              id: 'ownerUser',
              email: 'o@o',
              roleId: 'ownerRole',
              roleRef: { name: 'owner' },
            };
          }
          if (where.id === 'ownerUser2') {
            return { id: 'ownerUser2', roleRef: { name: 'owner' } };
          }
          return null;
        },
        count: async () => 1,
      },
      role: {
        findUnique: async () => ({ id: 'otherRole', name: 'admin_manager' }),
      },
    });
    await expect(
      svc.assignRoleToUser('ownerUser', 'otherRole', 'ownerUser2'),
    ).rejects.toMatchObject({ response: { message: 'LAST_OWNER_LOCK' } });
  });

  it('assignRoleToUser: allows Owner→Owner grant when actor is an Owner', async () => {
    const users = new Map<string, unknown>([
      [
        'target',
        {
          id: 'target',
          email: 't@t',
          roleId: 'admRole',
          roleRef: { name: 'admin_manager' },
        },
      ],
      ['actor', { id: 'actor', roleRef: { name: 'owner' } }],
    ]);
    buildSvc({
      user: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          users.get(where.id) ?? null,
        update: async () => ({}),
      },
      role: {
        findUnique: async () => ({ id: 'ownerRole', name: 'owner' }),
      },
    });
    await expect(
      svc.assignRoleToUser('target', 'ownerRole', 'actor'),
    ).resolves.toMatchObject({ id: 'target', roleId: 'ownerRole' });
  });
});
