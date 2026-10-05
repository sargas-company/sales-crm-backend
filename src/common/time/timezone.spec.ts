import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  safeTimezone,
  getLocalParts,
  getLocalDateString,
  getLocalDateMidnightUtc,
} from './timezone';

describe('timezone helpers', () => {
  describe('isValidTimezone / safeTimezone', () => {
    it('accepts well-known IANA zones', () => {
      for (const z of [
        'Europe/Kyiv',
        'Europe/London',
        'UTC',
        'America/New_York',
        'Asia/Tokyo',
      ]) {
        expect(isValidTimezone(z)).toBe(true);
        expect(safeTimezone(z)).toBe(z);
      }
    });

    it('rejects non-string / empty values', () => {
      expect(isValidTimezone(null)).toBe(false);
      expect(isValidTimezone(undefined)).toBe(false);
      expect(isValidTimezone('')).toBe(false);
      expect(isValidTimezone(42 as unknown)).toBe(false);
    });

    it('rejects nonsense strings', () => {
      expect(isValidTimezone('Pluto/Mons')).toBe(false);
      expect(isValidTimezone('Europe/Nowhere')).toBe(false);
    });

    it('safeTimezone falls back to Europe/Kyiv', () => {
      expect(safeTimezone('Pluto/Mons')).toBe(DEFAULT_TIMEZONE);
      expect(safeTimezone(null)).toBe(DEFAULT_TIMEZONE);
      expect(safeTimezone(undefined)).toBe(DEFAULT_TIMEZONE);
    });
  });

  describe('getLocalParts', () => {
    // Fixed instant: 2026-10-04T06:30:00Z.
    const INSTANT = new Date('2026-10-04T06:30:00Z');

    it('UTC parts match the input', () => {
      const p = getLocalParts(INSTANT, 'UTC');
      expect(p).toEqual({
        year: 2026,
        month: 10,
        day: 4,
        hour: 6,
        minute: 30,
      });
    });

    it('Europe/Kyiv is +3h in October 2026 (EEST)', () => {
      const p = getLocalParts(INSTANT, 'Europe/Kyiv');
      expect(p.hour).toBe(9);
      expect(p.minute).toBe(30);
      expect(p.day).toBe(4);
    });

    it('America/New_York is -4h in October 2026 (EDT)', () => {
      const p = getLocalParts(INSTANT, 'America/New_York');
      expect(p.hour).toBe(2);
      expect(p.minute).toBe(30);
      expect(p.day).toBe(4);
    });
  });

  describe('getLocalDateString + midnight-UTC', () => {
    // 2026-01-01T22:00:00Z — in Europe/Kyiv it's already Jan 2.
    const CROSSOVER = new Date('2026-01-01T22:00:00Z');

    it('crosses to the next local day in Europe/Kyiv', () => {
      expect(getLocalDateString(CROSSOVER, 'Europe/Kyiv')).toBe('2026-01-02');
      expect(getLocalDateString(CROSSOVER, 'UTC')).toBe('2026-01-01');
    });

    it('midnight-UTC yields the right calendar day', () => {
      const d = getLocalDateMidnightUtc(CROSSOVER, 'Europe/Kyiv');
      expect(d.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    });
  });
});
