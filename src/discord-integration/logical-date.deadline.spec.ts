/**
 * Daily-digest vs late-report deadline: there must be no 59-second
 * race around the configured `dailyDigestAt` where one path thinks
 * the report is late and the other picks it up anyway. The single
 * source of truth is `isLateReport(now, tz, dailyDigestAt)` with a
 * `HH:MM` deadline.
 *
 * Rule:
 *   createdAt <  deadline → normal (digest will pick it up)
 *   createdAt >= deadline → late   (digest already won't)
 */
import { describe, expect, it } from '@jest/globals';

import { isLateReport, parseHHMM } from './logical-date';

const TZ = 'Europe/Kyiv';

/** Local-wall-clock → UTC Date, assuming no DST transition on that minute. */
function kyiv(iso: string): Date {
  // iso = 'YYYY-MM-DDTHH:MM:SS'; convert via offset from Intl.
  // Simplest: construct a Date in UTC then adjust by the local
  // offset at that moment. For deterministic tests we pick a day
  // outside DST transitions (Feb for winter, Jul for summer).
  const [datePart, timePart] = iso.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [H, M, S] = timePart.split(':').map(Number);
  // Winter time in Europe/Kyiv is UTC+2, summer is UTC+3. The test
  // day in February is winter → offset = 2h.
  const offsetHours = (() => {
    const guess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      hour12: false,
      hour: '2-digit',
    }).formatToParts(guess);
    const localHour = Number.parseInt(
      parts.find((p) => p.type === 'hour')?.value ?? '12',
      10,
    );
    return localHour - 12;
  })();
  return new Date(Date.UTC(y, m - 1, d, H - offsetHours, M, S));
}

describe('isLateReport — HH:MM deadline', () => {
  it('18:59:59 Kyiv is NOT late (strictly before 19:00)', () => {
    expect(isLateReport(kyiv('2026-02-10T18:59:59'), TZ, '19:00')).toBe(false);
  });
  it('19:00:00 Kyiv IS late (at the deadline)', () => {
    expect(isLateReport(kyiv('2026-02-10T19:00:00'), TZ, '19:00')).toBe(true);
  });
  it('19:00:01 Kyiv IS late (just past the deadline)', () => {
    expect(isLateReport(kyiv('2026-02-10T19:00:01'), TZ, '19:00')).toBe(true);
  });
  it('morning report before cutoff for previous logical date IS late', () => {
    // 08:00 Kyiv — before 10:00 cutoff → logical date is yesterday.
    // Yesterday < today → late regardless of time-of-day.
    expect(isLateReport(kyiv('2026-02-10T08:00:00'), TZ, '19:00')).toBe(true);
  });
});

describe('parseHHMM', () => {
  it('parses valid HH:MM', () => {
    expect(parseHHMM('09:30')).toBe(9 * 60 + 30);
    expect(parseHHMM('23:59')).toBe(23 * 60 + 59);
    expect(parseHHMM('00:00')).toBe(0);
  });
  it('falls back to 19:00 on malformed input', () => {
    expect(parseHHMM('bogus')).toBe(19 * 60);
    expect(parseHHMM('25:00')).toBe(19 * 60);
    expect(parseHHMM('')).toBe(19 * 60);
  });
});
