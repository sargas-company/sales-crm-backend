import { describe, it, expect, beforeEach } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { AuthUser } from '../auth/auth-user';
import { ProjectService } from './project.service';

/**
 * Fully-mocked unit test for the start/end date invariant added in the
 * MVP-stabilisation audit. The service refuses payloads where
 * `startDate > endDate` on both create and update.
 */
const makePrisma = (): PrismaService =>
  ({
    counterparty: {
      findUnique: async () => ({ id: 'c1', type: 'client' }),
    },
    employee: {
      findMany: async () => [],
    },
    project: {
      findUnique: async () => ({ id: 'p1' }),
      findUniqueOrThrow: async () => ({
        id: 'p1',
        startDate: null,
        endDate: null,
        members: [],
      }),
    },
    projectMember: {
      findUnique: async () => ({ id: 'pm1' }),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
  }) as unknown as PrismaService;

const noopAudit: AuditEventService = {
  recordSafe: async () => undefined,
} as unknown as AuditEventService;

const OWNER: AuthUser = {
  id: 'u1',
  email: 'o@x',
  roleName: 'owner',
  permissions: new Set(['projects:view', 'projects:view_any']),
} as unknown as AuthUser;

describe('ProjectService date-range invariant', () => {
  let svc: ProjectService;

  beforeEach(() => {
    svc = new ProjectService(makePrisma(), noopAudit);
  });

  it('create: rejects startDate > endDate with 400', async () => {
    await expect(
      svc.create(
        {
          name: 'x',
          startDate: '2026-05-10',
          endDate: '2026-05-01',
        },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: accepts startDate == endDate', async () => {
    // We expect the invariant NOT to throw. The underlying prisma mock
    // doesn't fully model `.create`, so a thrown error from a later
    // step is acceptable — what we assert is the invariant did not
    // raise BadRequestException with the date-range message.
    await expect(
      (async () => {
        try {
          await svc.create(
            {
              name: 'x',
              startDate: '2026-05-10',
              endDate: '2026-05-10',
            },
            OWNER,
          );
        } catch (e) {
          if (
            e instanceof BadRequestException &&
            String((e.getResponse() as { message?: string }).message).includes(
              'startDate must be on or before endDate',
            )
          ) {
            throw e;
          }
          // Some other failure from the mocked prisma — that's fine
          // for this unit, we only care about the range check.
        }
      })(),
    ).resolves.toBeUndefined();
  });
});
