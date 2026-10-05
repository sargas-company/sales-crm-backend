import { BackupStatus, type BackupRun } from '@prisma/client';

/**
 * Pure gate used by `scripts/require-fresh-backup.ts` (and its tests).
 * Enforces the policy "no production migration without a fresh,
 * VERIFIED backup". Rules:
 *
 *   - For production (`APP_ENV=production`) the latest VERIFIED run
 *     for THIS environment must be no older than `maxAgeMs`
 *     (24 h by default).
 *   - For pre-migration flow (`requireCurrentRun=true`) the latest
 *     VERIFIED must have been created *within this invocation* — the
 *     caller passes `currentRunId` and the gate requires that id to
 *     be the one that satisfies the check.
 *   - For any other environment the gate still demands a VERIFIED
 *     run exists; it does not enforce an age or run-id, so local
 *     scripts stay usable without flakiness.
 */
export interface MigrationGateInput {
  environment: string;
  now: Date;
  latestVerified: Pick<BackupRun, 'id' | 'startedAt' | 'environment' | 'status'> | null;
  maxAgeMs?: number;
  requireCurrentRun?: boolean;
  currentRunId?: string | null;
}

export interface MigrationGateResult {
  ok: boolean;
  reason?: string;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function evaluateMigrationGate(
  input: MigrationGateInput,
): MigrationGateResult {
  const { environment, now, latestVerified } = input;

  if (!latestVerified) {
    return { ok: false, reason: 'no VERIFIED backup exists' };
  }
  if (latestVerified.status !== BackupStatus.VERIFIED) {
    return { ok: false, reason: 'latest candidate backup is not VERIFIED' };
  }

  if (input.requireCurrentRun) {
    if (!input.currentRunId) {
      return { ok: false, reason: 'pre-migration flow requires --current-run-id' };
    }
    if (latestVerified.id !== input.currentRunId) {
      return {
        ok: false,
        reason: `pre-migration flow requires the current run to be the latest VERIFIED; latest is ${latestVerified.id}, current is ${input.currentRunId}`,
      };
    }
  }

  if (environment === 'production') {
    if (latestVerified.environment !== 'production') {
      return {
        ok: false,
        reason: `latest VERIFIED backup is from environment "${latestVerified.environment}"; production gate requires a production backup`,
      };
    }
    const ageMs = now.getTime() - latestVerified.startedAt.getTime();
    const limit = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (ageMs > limit) {
      return {
        ok: false,
        reason: `latest VERIFIED backup is ${(ageMs / 3600_000).toFixed(1)}h old; production gate requires it to be at most ${(limit / 3600_000).toFixed(0)}h`,
      };
    }
  }

  return { ok: true };
}
