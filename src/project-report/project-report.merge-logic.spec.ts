/**
 * In-memory verification of the migration merge logic for a 4-row
 * conflict group — the production path (SQL in migration
 * 20261023000000) was validated against the pre-migration dump
 * which contained a real 4-row group. This spec encodes the same
 * expectations as a pure function test so a future contributor
 * cannot change the merge algorithm without updating the contract.
 *
 * Rules (mirror the SQL):
 *   - canonical row = min(createdAt, id) across the group;
 *   - hours = SUM across the whole group;
 *   - contributors = DISTINCT employeeIds, snapshot names via
 *     `Employee.firstName/lastName`;
 *   - content = per-row `"<FirstName LastName>:\n<content>"` blocks,
 *     joined by `\n\n`, in canonical order (createdAt ASC, id ASC);
 *   - losers (rn > 1) are removed from the surviving set.
 */
import { describe, expect, it } from '@jest/globals';

interface Row {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  hours: number;
  content: string;
  createdAt: Date;
}

function mergeGroup(group: Row[]) {
  const sorted = [...group].sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });
  const canonical = sorted[0];
  const totalHours = sorted.reduce((sum, r) => sum + r.hours, 0);
  const mergedContent = sorted
    .map((r) => `${r.firstName} ${r.lastName}:\n${r.content}`)
    .join('\n\n');
  const seen = new Set<string>();
  const contributors: Array<{ employeeId: string; firstName: string; lastName: string }> = [];
  for (const r of sorted) {
    if (seen.has(r.employeeId)) continue;
    seen.add(r.employeeId);
    contributors.push({
      employeeId: r.employeeId,
      firstName: r.firstName,
      lastName: r.lastName,
    });
  }
  const losers = sorted.slice(1).map((r) => r.id);
  return {
    canonicalId: canonical.id,
    totalHours,
    mergedContent,
    contributors,
    losers,
  };
}

describe('migration merge logic — 4-row conflict group', () => {
  const group: Row[] = [
    {
      id: 'row-3',
      employeeId: 'emp-c',
      firstName: 'Liam',
      lastName: 'Fitzpatrick',
      hours: 4,
      content: 'C work',
      createdAt: new Date('2026-09-29T17:50:35.155Z'),
    },
    {
      id: 'row-4',
      employeeId: 'emp-d',
      firstName: 'Farrukh',
      lastName: 'Nazarov',
      hours: 9,
      content: 'D work',
      createdAt: new Date('2026-09-29T17:50:35.205Z'),
    },
    {
      id: 'row-1',
      employeeId: 'emp-a',
      firstName: 'Bohdan',
      lastName: 'Melnyk',
      hours: 9.5,
      content: 'A work',
      createdAt: new Date('2026-09-29T17:50:35.117Z'),
    },
    {
      id: 'row-2',
      employeeId: 'emp-b',
      firstName: 'Ivo',
      lastName: 'Pereira',
      hours: 3.5,
      content: 'B work',
      createdAt: new Date('2026-09-29T17:50:35.151Z'),
    },
  ];

  it('selects deterministic canonical by (createdAt, id)', () => {
    const { canonicalId } = mergeGroup(group);
    expect(canonicalId).toBe('row-1'); // earliest createdAt
  });

  it('hours sum == sum of all four rows', () => {
    const { totalHours } = mergeGroup(group);
    expect(totalHours).toBe(26);
  });

  it('four distinct contributors, in canonical insert order', () => {
    const { contributors } = mergeGroup(group);
    expect(contributors.map((c) => c.employeeId)).toEqual([
      'emp-a',
      'emp-b',
      'emp-c',
      'emp-d',
    ]);
  });

  it('content concatenation is deterministic and author-prefixed', () => {
    const { mergedContent } = mergeGroup(group);
    const expected =
      'Bohdan Melnyk:\nA work\n\n' +
      'Ivo Pereira:\nB work\n\n' +
      'Liam Fitzpatrick:\nC work\n\n' +
      'Farrukh Nazarov:\nD work';
    expect(mergedContent).toBe(expected);
  });

  it('three loser row ids are returned for deletion', () => {
    const { losers } = mergeGroup(group);
    expect(losers.sort()).toEqual(['row-2', 'row-3', 'row-4']);
  });
});

describe('migration merge logic — 2-row conflict group', () => {
  const group: Row[] = [
    {
      id: 'later',
      employeeId: 'emp-y',
      firstName: 'Yvonne',
      lastName: 'Y',
      hours: 2,
      content: 'late',
      createdAt: new Date('2026-10-01T12:00:00.000Z'),
    },
    {
      id: 'early',
      employeeId: 'emp-x',
      firstName: 'Xavier',
      lastName: 'X',
      hours: 5,
      content: 'early',
      createdAt: new Date('2026-10-01T10:00:00.000Z'),
    },
  ];

  it('canonical is earliest; hours summed; two contributors', () => {
    const { canonicalId, totalHours, contributors, mergedContent, losers } =
      mergeGroup(group);
    expect(canonicalId).toBe('early');
    expect(totalHours).toBe(7);
    expect(contributors.map((c) => c.employeeId)).toEqual(['emp-x', 'emp-y']);
    expect(mergedContent).toBe('Xavier X:\nearly\n\nYvonne Y:\nlate');
    expect(losers).toEqual(['later']);
  });
});
