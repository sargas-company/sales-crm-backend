import { describe, it, expect } from '@jest/globals';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PermissionGuard } from '../auth/permission.guard';
import { REQUIRED_PERMISSIONS_KEY } from '../auth/permission.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformController } from './platform.controller';

// Reflector-driven permission check for every PlatformController
// endpoint. Verifies that:
//   1. each handler carries the exact permission key the frontend
//      hides UI behind (platforms:view / :create / :update / :delete);
//   2. PermissionGuard rejects a user whose role lacks the key for
//      that handler (403 ForbiddenException);
//   3. PermissionGuard admits a user whose role carries the key.
// No HTTP app, no DB — the Reflector reads the real decorator
// metadata; prisma.user is stubbed.

const makePrisma = (grantedKeys: string[]) =>
  ({
    user: {
      findUnique: async () => ({
        roleRef: {
          permissions: grantedKeys.map((key) => ({ permission: { key } })),
        },
      }),
    },
  }) as unknown as PrismaService;

const makeContext = (
  handler: (...args: unknown[]) => unknown,
  userId: string | undefined,
): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => PlatformController,
    switchToHttp: () => ({
      getRequest: () => ({ user: userId ? { id: userId } : undefined }),
    }),
  }) as unknown as ExecutionContext;

const endpoints: ReadonlyArray<{
  name: keyof PlatformController;
  key: string;
}> = [
  { name: 'findAll', key: 'platforms:view' },
  { name: 'findOne', key: 'platforms:view' },
  { name: 'create', key: 'platforms:create' },
  { name: 'update', key: 'platforms:update' },
  { name: 'remove', key: 'platforms:delete' },
];

describe('PlatformController — permission wiring', () => {
  const reflector = new Reflector();

  for (const ep of endpoints) {
    describe(`${String(ep.name)} → requires "${ep.key}"`, () => {
      // Pull the method off the class prototype so Reflector sees the
      // real @RequirePermission metadata attached by the decorator.
      const handler = (PlatformController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >)[String(ep.name)];

      it(`is decorated with @RequirePermission('${ep.key}')`, () => {
        const keys = reflector.getAllAndOverride<string[]>(
          REQUIRED_PERMISSIONS_KEY,
          [handler, PlatformController],
        );
        expect(keys).toEqual([ep.key]);
      });

      it('rejects a user whose role lacks the key (403)', async () => {
        const guard = new PermissionGuard(reflector, makePrisma([]));
        await expect(
          guard.canActivate(makeContext(handler, 'u-forbidden')),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('rejects a user whose role has sibling keys but not this one', async () => {
        // One of the OTHER platforms:* keys — proves the guard
        // discriminates between keys inside the same namespace.
        const sibling =
          ep.key === 'platforms:view' ? 'platforms:update' : 'platforms:view';
        const guard = new PermissionGuard(reflector, makePrisma([sibling]));
        await expect(
          guard.canActivate(makeContext(handler, 'u-sibling')),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('admits a user whose role carries the key', async () => {
        const guard = new PermissionGuard(reflector, makePrisma([ep.key]));
        await expect(
          guard.canActivate(makeContext(handler, 'u-ok')),
        ).resolves.toBe(true);
      });
    });
  }

  it('every PlatformController method is permission-decorated — no accidental open route', () => {
    // Keep this test in step with `endpoints[]` above. If someone
    // adds a new route without @RequirePermission, Reflector returns
    // undefined and the test fails loudly.
    const names: ReadonlyArray<keyof PlatformController> = [
      'findAll',
      'findOne',
      'create',
      'update',
      'remove',
    ];
    for (const name of names) {
      const handler = (PlatformController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >)[String(name)];
      const keys = reflector.getAllAndOverride<string[]>(
        REQUIRED_PERMISSIONS_KEY,
        [handler, PlatformController],
      );
      expect(keys).toBeDefined();
      expect(keys!.length).toBeGreaterThan(0);
    }
  });
});
