import { describe, it, expect } from '@jest/globals';
import { TimeOffService } from './time-off.service';

/* Confirms the year-isolation contract: a single range that crosses
 * December 31 → January 1 contributes its working days to the OLD
 * year up to Dec 31 and to the NEW year from Jan 1. There is no
 * carry-over of unused balance from the previous year. */

const svc = new TimeOffService({} as never, {} as never);

describe('TimeOffService.workingDaysInYear', () => {
  it('splits a year-crossing range on the calendar boundary', () => {
    const start = new Date('2025-12-29T00:00:00.000Z'); // Mon
    const end = new Date('2026-01-05T00:00:00.000Z'); // Mon
    const inYear = (
      svc as unknown as {
        workingDaysInYear: (
          s: Date,
          e: Date,
          y: number,
          w?: Set<number>,
        ) => number;
      }
    ).workingDaysInYear;
    const inYear2025 = inYear.call(svc, start, end, 2025);
    const inYear2026 = inYear.call(svc, start, end, 2026);
    // Mon-Tue-Wed-Thu-Fri = 2025 working days 29, 30, 31 → 3
    expect(inYear2025).toBe(3);
    // 2026-01-01 (Thu), -02 (Fri), -05 (Mon) → 3
    expect(inYear2026).toBe(3);
  });

  it('returns 0 for a range entirely outside the queried year', () => {
    const start = new Date('2025-06-01T00:00:00.000Z');
    const end = new Date('2025-06-10T00:00:00.000Z');
    const inYear = (
      svc as unknown as {
        workingDaysInYear: (
          s: Date,
          e: Date,
          y: number,
          w?: Set<number>,
        ) => number;
      }
    ).workingDaysInYear;
    expect(inYear.call(svc, start, end, 2026)).toBe(0);
  });

  it('a new calendar year starts fresh — allowance NOT carried over', () => {
    // Working-days used in 2025 do not influence the 2026 bucket.
    const r1Start = new Date('2025-11-10T00:00:00.000Z');
    const r1End = new Date('2025-11-14T00:00:00.000Z');
    const r2Start = new Date('2026-02-02T00:00:00.000Z');
    const r2End = new Date('2026-02-06T00:00:00.000Z');
    const inYear = (
      svc as unknown as {
        workingDaysInYear: (
          s: Date,
          e: Date,
          y: number,
          w?: Set<number>,
        ) => number;
      }
    ).workingDaysInYear;
    const used2025 = inYear.call(svc, r1Start, r1End, 2025);
    const used2026 = inYear.call(svc, r2Start, r2End, 2026);
    // Each range: 5 weekday working days.
    expect(used2025).toBe(5);
    expect(used2026).toBe(5);
    // Prior-year usage does not leak into the next year's counter.
    expect(inYear.call(svc, r1Start, r1End, 2026)).toBe(0);
    expect(inYear.call(svc, r2Start, r2End, 2025)).toBe(0);
  });
});
