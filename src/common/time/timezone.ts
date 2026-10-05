/**
 * Minimal timezone helpers that avoid pulling in `date-fns-tz` or
 * `luxon`. Backed by `Intl.DateTimeFormat`, which Node 20+ exposes
 * with full IANA zone support out of the box.
 *
 * Stored timestamps always stay in UTC. These helpers only translate
 * UTC instants into the configured business zone for comparison and
 * calendar-day deduplication.
 */

export const DEFAULT_TIMEZONE = 'Europe/Kyiv';

/** True if `name` is an IANA zone the current runtime recognizes. */
export function isValidTimezone(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Returns `name` when valid, else the workspace default. Never throws. */
export function safeTimezone(name: unknown): string {
  return isValidTimezone(name) ? name : DEFAULT_TIMEZONE;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Decompose a UTC instant into {year, month, day, hour, minute}
 *  in the target timezone. */
export function getLocalParts(date: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const grab = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: grab('year'),
    month: grab('month'),
    day: grab('day'),
    hour: grab('hour'),
    minute: grab('minute'),
  };
}

/** `YYYY-MM-DD` for the local calendar day of `date` in `tz`. */
export function getLocalDateString(date: Date, tz: string): string {
  const p = getLocalParts(date, tz);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

/** Convenience: a `Date` positioned at local midnight of `date` in
 *  `tz`, expressed in UTC so Prisma's `@db.Date` column stores the
 *  intended calendar day. */
export function getLocalDateMidnightUtc(date: Date, tz: string): Date {
  const iso = `${getLocalDateString(date, tz)}T00:00:00.000Z`;
  return new Date(iso);
}
