import { BackupStatus, type BackupRun } from '@prisma/client';

/**
 * Pure retention logic shared between `scripts/prune-backups.ts` and
 * its tests. Given the list of all runs and the cutoff date, returns
 * the ids that are eligible for prune under the policy:
 *
 *   - a run is eligible iff `startedAt < cutoff`;
 *   - the single most recent VERIFIED run is NEVER eligible, no
 *     matter how old. A `SUCCEEDED` row without downstream
 *     verification is NOT treated as a safe-to-keep anchor — only
 *     dumps that round-tripped through B2 and `pg_restore --list`
 *     count. When there is no VERIFIED row at all the retention
 *     window still applies to every candidate.
 *   - type is irrelevant: DAILY / PRE_MIGRATION / PRE_SEED / MANUAL
 *     share one retention window.
 *
 * Input is read-only — the function never mutates its argument.
 */
export function pickRunsToPrune<
  R extends Pick<BackupRun, 'id' | 'status' | 'startedAt'>,
>(runs: ReadonlyArray<R>, cutoff: Date): R[] {
  const latestVerified = runs
    .filter((r) => r.status === BackupStatus.VERIFIED)
    .reduce<R | null>(
      (acc, r) =>
        !acc || r.startedAt.getTime() > acc.startedAt.getTime() ? r : acc,
      null,
    );

  return runs.filter(
    (r) =>
      r.startedAt.getTime() < cutoff.getTime() &&
      (!latestVerified || r.id !== latestVerified.id),
  );
}
