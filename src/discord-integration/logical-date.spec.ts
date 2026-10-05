import { describe, it, expect } from '@jest/globals';
import {
  isLateReport,
  localCalendarDate,
  logicalReportDate,
} from './logical-date';

const TZ = 'Europe/Kyiv';

// Build an instant from a Kyiv-local wall clock. We hand-pick UTC
// offsets so each test is explicit about DST vs standard time.
function fromKyiv(
  y: number,
  m: number,
  d: number,
  h: number,
  min = 0,
  offset: '+02' | '+03' = '+03',
): Date {
  const pad = (n: number) => String(n).padStart(2, '0');
  return new Date(
    `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:00${offset}:00`,
  );
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe('logicalReportDate', () => {
  it('credits a submission at 09:59 to the previous day', () => {
    expect(iso(logicalReportDate({ now: fromKyiv(2026, 10, 4, 9, 59), timezone: TZ }))).toBe(
      '2026-10-03',
    );
  });

  it('credits a submission at exactly 10:00 to the same day', () => {
    expect(iso(logicalReportDate({ now: fromKyiv(2026, 10, 4, 10, 0), timezone: TZ }))).toBe(
      '2026-10-04',
    );
  });

  it('wraps backwards across a month boundary', () => {
    expect(iso(logicalReportDate({ now: fromKyiv(2026, 11, 1, 0, 30), timezone: TZ }))).toBe(
      '2026-10-31',
    );
  });

  it('wraps backwards across a year boundary', () => {
    expect(iso(logicalReportDate({ now: fromKyiv(2026, 1, 1, 2, 0, '+02'), timezone: TZ }))).toBe(
      '2025-12-31',
    );
  });

  it('respects DST — EEST → EET transition in late October', () => {
    // Oct 25, 2026 03:00 EEST = 00:00 UTC → clocks fall back; same
    // Kyiv wall time is EET afterwards. The logical date rule is
    // tied to the local hour, not to UTC offsets.
    const beforeDst = fromKyiv(2026, 10, 25, 2, 30, '+03');
    const afterDst = fromKyiv(2026, 10, 25, 2, 30, '+02');
    expect(iso(logicalReportDate({ now: beforeDst, timezone: TZ }))).toBe('2026-10-24');
    expect(iso(logicalReportDate({ now: afterDst, timezone: TZ }))).toBe('2026-10-24');
  });

  it('honours a custom cutoffHour (e.g. 11:00)', () => {
    expect(
      iso(logicalReportDate({ now: fromKyiv(2026, 10, 4, 10, 30), timezone: TZ, cutoffHour: 11 })),
    ).toBe('2026-10-03');
    expect(
      iso(logicalReportDate({ now: fromKyiv(2026, 10, 4, 11, 0), timezone: TZ, cutoffHour: 11 })),
    ).toBe('2026-10-04');
  });
});

describe('localCalendarDate', () => {
  it('returns the local day regardless of UTC calendar', () => {
    // 2026-01-01 00:30 Kyiv = 2025-12-31 22:30 UTC
    const d = fromKyiv(2026, 1, 1, 0, 30, '+02');
    expect(iso(localCalendarDate(d, TZ))).toBe('2026-01-01');
  });
});

describe('isLateReport', () => {
  it('false at 15:00 when logical day == today', () => {
    expect(isLateReport(fromKyiv(2026, 10, 4, 15, 0), TZ)).toBe(false);
  });
  it('true after 19:00 on same calendar day', () => {
    expect(isLateReport(fromKyiv(2026, 10, 4, 19, 1), TZ)).toBe(true);
  });
  it('true at 03:00 (next calendar day for a previous logical day)', () => {
    // 03:00 is before the 10:00 cutoff → logical day is yesterday.
    // Yesterday < today → late.
    expect(isLateReport(fromKyiv(2026, 10, 5, 3, 0), TZ)).toBe(true);
  });
  it('false just before 19:00', () => {
    expect(isLateReport(fromKyiv(2026, 10, 4, 18, 59), TZ)).toBe(false);
  });
});
