import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { AuditResult, AuditSeverity } from '@prisma/client';

import { PayrollService } from './payroll.service';
import { SK } from '../settings/settings-registry';

/*
 * Narrow unit test for the PAID-run lock + reopen gating. We spin up
 * a lightweight stub service with just the three collaborators used
 * by the lock paths; the pure Prisma CRUD paths are not exercised.
 */

type SettingValue = boolean | number;

function makeSvc(
  settings: Partial<Record<string, SettingValue>> = {},
): {
  svc: PayrollService;
  audit: { calls: Array<Record<string, unknown>> };
} {
  const auditCalls: Array<Record<string, unknown>> = [];
  const auditStub = {
    recordSafe: jest.fn(async (entry: Record<string, unknown>) => {
      auditCalls.push(entry);
    }),
  };
  const settingsStub = {
    getBooleanForKey: jest.fn(async (key: string, fallback: boolean) => {
      const v = settings[key];
      return typeof v === 'boolean' ? v : fallback;
    }),
    getNumberForKey: jest.fn(async (key: string, fallback: number) => {
      const v = settings[key];
      return typeof v === 'number' ? v : fallback;
    }),
    getStringForKey: jest.fn(async (_key: string, fallback: string) => fallback),
  };
  const svc = new PayrollService(
    {} as never,
    auditStub as unknown as never,
    settingsStub as unknown as never,
  );
  return { svc, audit: { calls: auditCalls } };
}

const existingPaid = {
  id: 'entry-1',
  employee: { firstName: 'A', lastName: 'B' },
  year: 2026,
  month: 10,
};

describe('Payroll paid-run lock', () => {
  it('throws ConflictException when LOCK=true', async () => {
    const { svc, audit } = makeSvc({
      [SK.PAYROLL_LOCK_PAID_RUNS]: true,
    });
    await expect(
      (svc as unknown as {
        assertPaidMutable: (
          e: typeof existingPaid,
          actorId: string,
          action: string,
        ) => Promise<void>;
      }).assertPaidMutable(existingPaid, 'actor-1', 'payroll.update'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0].result).toBe(AuditResult.DENIED);
    expect(audit.calls[0].severity).toBe(AuditSeverity.WARNING);
    expect(audit.calls[0].action).toBe('payroll.update');
  });

  it('allows mutation when LOCK=false, no audit DENIED emitted', async () => {
    const { svc, audit } = makeSvc({
      [SK.PAYROLL_LOCK_PAID_RUNS]: false,
    });
    await (svc as unknown as {
      assertPaidMutable: (
        e: typeof existingPaid,
        actorId: string,
        action: string,
      ) => Promise<void>;
    }).assertPaidMutable(existingPaid, 'actor-1', 'payroll.update');
    expect(audit.calls).toHaveLength(0);
  });

  it('defaults to locked when the setting is missing', async () => {
    const { svc } = makeSvc({});
    await expect(
      (svc as unknown as {
        assertPaidMutable: (
          e: typeof existingPaid,
          actorId: string,
          action: string,
        ) => Promise<void>;
      }).assertPaidMutable(existingPaid, 'actor-1', 'payroll.delete'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
