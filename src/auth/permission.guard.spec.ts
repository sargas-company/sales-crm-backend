import { describe, it, expect } from '@jest/globals';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PrismaService } from '../prisma/prisma.service';
import { PermissionGuard } from './permission.guard';

// Fully-mocked unit tests for the guard. No DB, no HTTP.
// Exercises: no-metadata pass-through, missing user, missing role,
// missing permission (single + AND-list), and the happy path.

const makeReflector = (keys: string[] | undefined) =>
  ({
    getAllAndOverride: () => keys,
  }) as unknown as Reflector;

const makePrisma = (
  role: null | { permissions: { permission: { key: string } }[] },
) =>
  ({
    user: {
      findUnique: async () => (role === null ? null : { roleRef: role }),
    },
  }) as unknown as PrismaService;

const makeContext = (userId: string | undefined): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({ user: userId ? { id: userId } : undefined }),
    }),
  }) as unknown as ExecutionContext;

describe('PermissionGuard', () => {
  it('passes through when no @RequirePermission metadata is present', async () => {
    const guard = new PermissionGuard(makeReflector(undefined), makePrisma(null));
    await expect(guard.canActivate(makeContext('any'))).resolves.toBe(true);
  });

  it('passes through when the metadata array is empty', async () => {
    const guard = new PermissionGuard(makeReflector([]), makePrisma(null));
    await expect(guard.canActivate(makeContext('any'))).resolves.toBe(true);
  });

  it('rejects when req.user.id is missing', async () => {
    const guard = new PermissionGuard(
      makeReflector(['prompts:view']),
      makePrisma(null),
    );
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects when the user has no role assigned', async () => {
    const guard = new PermissionGuard(
      makeReflector(['prompts:view']),
      makePrisma(null),
    );
    await expect(guard.canActivate(makeContext('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects when the required key is missing from the role', async () => {
    const guard = new PermissionGuard(
      makeReflector(['prompts:view']),
      makePrisma({ permissions: [{ permission: { key: 'invoices:view' } }] }),
    );
    await expect(guard.canActivate(makeContext('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('grants when the single required key is present', async () => {
    const guard = new PermissionGuard(
      makeReflector(['prompts:view']),
      makePrisma({
        permissions: [
          { permission: { key: 'prompts:view' } },
          { permission: { key: 'invoices:view' } },
        ],
      }),
    );
    await expect(guard.canActivate(makeContext('u1'))).resolves.toBe(true);
  });

  it('AND-semantics: rejects when only some keys are granted', async () => {
    const guard = new PermissionGuard(
      makeReflector(['roles:update', 'roles:assign']),
      makePrisma({
        permissions: [{ permission: { key: 'roles:update' } }],
      }),
    );
    await expect(guard.canActivate(makeContext('u1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('AND-semantics: grants when every key is granted', async () => {
    const guard = new PermissionGuard(
      makeReflector(['roles:update', 'roles:assign']),
      makePrisma({
        permissions: [
          { permission: { key: 'roles:update' } },
          { permission: { key: 'roles:assign' } },
          { permission: { key: 'roles:delete' } },
        ],
      }),
    );
    await expect(guard.canActivate(makeContext('u1'))).resolves.toBe(true);
  });
});
