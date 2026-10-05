import { describe, it, expect } from '@jest/globals';
import { BackupStatus, BackupType, type BackupRun } from '@prisma/client';

import { pickRunsToPrune } from './retention';

/**
 * `scripts/prune-backups.ts` builds its candidate list via this
 * helper, so these tests cover the retention invariants without
 * running the script itself (which would need live B2 + DB).
 */

type R = Pick<BackupRun, 'id' | 'status' | 'startedAt'>;

const d = (iso: string) => new Date(iso);

describe('pickRunsToPrune', () => {
  it('keeps the single most recent VERIFIED run even when older than the cutoff', () => {
    const runs: R[] = [
      { id: 'old-v', status: BackupStatus.VERIFIED, startedAt: d('2024-01-01') },
      { id: 'older-v', status: BackupStatus.VERIFIED, startedAt: d('2023-01-01') },
    ];
    const cutoff = d('2026-10-01');
    const prune = pickRunsToPrune(runs, cutoff);
    expect(prune.map((r) => r.id)).toEqual(['older-v']);
  });

  it('does NOT treat SUCCEEDED as a safe anchor — only VERIFIED survives retention', () => {
    const runs: R[] = [
      { id: 's1', status: BackupStatus.SUCCEEDED, startedAt: d('2024-01-01') },
      { id: 'old-failed', status: BackupStatus.FAILED, startedAt: d('2022-01-01') },
    ];
    const cutoff = d('2026-10-01');
    const prune = pickRunsToPrune(runs, cutoff).map((r) => r.id).sort();
    // Both are old; no VERIFIED exists → both get pruned.
    expect(prune).toEqual(['old-failed', 's1']);
  });

  it('leaves recent runs alone (no matter the status)', () => {
    // Both runs are ON or AFTER the cutoff — they stay regardless of
    // status.
    const cutoff = d('2026-09-01');
    const runs: R[] = [
      { id: 'recent-ok', status: BackupStatus.SUCCEEDED, startedAt: d('2026-09-30') },
      { id: 'recent-failed', status: BackupStatus.FAILED, startedAt: d('2026-09-29') },
    ];
    expect(pickRunsToPrune(runs, cutoff)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const runs: R[] = [
      { id: 'x', status: BackupStatus.FAILED, startedAt: d('2024-01-01') },
    ];
    const snapshot = JSON.parse(JSON.stringify(runs));
    pickRunsToPrune(runs, d('2026-10-01'));
    expect(JSON.parse(JSON.stringify(runs))).toEqual(snapshot);
  });

  it('treats every BackupType value equally', () => {
    const runs: R[] = Object.values(BackupType).map((t) => ({
      id: t,
      status: BackupStatus.FAILED,
      startedAt: d('2020-01-01'),
    }));
    const prune = pickRunsToPrune(runs, d('2026-10-01')).map((r) => r.id).sort();
    expect(prune).toEqual([...Object.values(BackupType)].sort());
  });
});
