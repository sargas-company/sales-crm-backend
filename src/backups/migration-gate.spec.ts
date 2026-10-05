import { describe, it, expect } from '@jest/globals';
import { BackupStatus } from '@prisma/client';
import { evaluateMigrationGate } from './migration-gate';

const now = new Date('2026-10-04T12:00:00Z');

describe('evaluateMigrationGate', () => {
  it('refuses when no VERIFIED backup exists', () => {
    const r = evaluateMigrationGate({
      environment: 'production',
      now,
      latestVerified: null,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no VERIFIED backup/);
  });

  it('accepts production when VERIFIED is < 24h old and matches env', () => {
    const r = evaluateMigrationGate({
      environment: 'production',
      now,
      latestVerified: {
        id: 'b1',
        status: BackupStatus.VERIFIED,
        environment: 'production',
        startedAt: new Date('2026-10-04T10:00:00Z'),
      },
    });
    expect(r.ok).toBe(true);
  });

  it('refuses production when VERIFIED > 24h old', () => {
    const r = evaluateMigrationGate({
      environment: 'production',
      now,
      latestVerified: {
        id: 'b1',
        status: BackupStatus.VERIFIED,
        environment: 'production',
        startedAt: new Date('2026-10-02T10:00:00Z'),
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/at most 24h/);
  });

  it('refuses production when VERIFIED is from another environment', () => {
    const r = evaluateMigrationGate({
      environment: 'production',
      now,
      latestVerified: {
        id: 'b1',
        status: BackupStatus.VERIFIED,
        environment: 'staging',
        startedAt: new Date('2026-10-04T10:00:00Z'),
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/requires a production backup/);
  });

  it('pre-migration flow refuses if currentRunId is not the latest VERIFIED', () => {
    const r = evaluateMigrationGate({
      environment: 'production',
      now,
      requireCurrentRun: true,
      currentRunId: 'different',
      latestVerified: {
        id: 'b1',
        status: BackupStatus.VERIFIED,
        environment: 'production',
        startedAt: new Date('2026-10-04T11:30:00Z'),
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pre-migration flow requires the current run/);
  });

  it('pre-migration flow accepts when currentRunId matches', () => {
    const r = evaluateMigrationGate({
      environment: 'production',
      now,
      requireCurrentRun: true,
      currentRunId: 'b1',
      latestVerified: {
        id: 'b1',
        status: BackupStatus.VERIFIED,
        environment: 'production',
        startedAt: new Date('2026-10-04T11:30:00Z'),
      },
    });
    expect(r.ok).toBe(true);
  });

  it('does not enforce age for non-production env', () => {
    const r = evaluateMigrationGate({
      environment: 'local',
      now,
      latestVerified: {
        id: 'b1',
        status: BackupStatus.VERIFIED,
        environment: 'local',
        startedAt: new Date('2024-01-01T00:00:00Z'),
      },
    });
    expect(r.ok).toBe(true);
  });

  it('refuses production when the only VERIFIED backup is a restored local dump', () => {
    // Regression against a cutover footgun: after the local DB is
    // pg_restore'd into production, the restored rows carry
    // `environment='local'`. The production gate must not treat
    // those as a valid prod backup, otherwise `prisma migrate
    // deploy` would run without a real production safety net.
    const r = evaluateMigrationGate({
      environment: 'production',
      now,
      latestVerified: {
        id: 'local-restored',
        status: BackupStatus.VERIFIED,
        environment: 'local',
        startedAt: new Date('2026-10-04T11:30:00Z'),
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/requires a production backup/);
    expect(r.reason).toMatch(/environment "local"/);
  });
});
