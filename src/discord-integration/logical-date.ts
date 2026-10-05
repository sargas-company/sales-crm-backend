/**
 * The "logical report date" rule copied verbatim from the old admin's
 * operational practice:
 *
 *   - submitted before `cutoffHour:00` local time → the report is
 *     credited to the previous calendar day;
 *   - submitted at `cutoffHour:00` or later → the report is credited
 *     to the current calendar day.
 *
 * Timezone is explicit (defaults to Europe/Kyiv). We never rely on
 * the host clock's timezone — the function derives the local
 * calendar date from the given `Date` + IANA timezone using
 * `Intl.DateTimeFormat`, which handles DST transitions and
 * leap-year boundaries correctly without any manual offsets.
 *
 * Returned shape is a UTC `Date` set to 00:00:00Z of the logical
 * calendar day, so Prisma `@db.Date` round-trips are stable.
 */
export interface LogicalDateInput {
  now: Date;
  cutoffHour?: number;
  timezone?: string;
}

const DEFAULT_CUTOFF = 10;
const DEFAULT_TZ = 'Europe/Kyiv';

function localDateParts(d: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
} {
  // `en-GB` + numeric parts gives us a stable yyyy-mm-dd HH shape
  // regardless of host locale.
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const grab = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number.parseInt(p.value, 10) : NaN;
  };
  // `hour: '2-digit'` with hour12=false still returns "24" for the
  // top of day on some runtimes; clamp to [0, 23].
  const rawHour = grab('hour');
  return {
    year: grab('year'),
    month: grab('month'),
    day: grab('day'),
    hour: rawHour === 24 ? 0 : rawHour,
  };
}

/**
 * Build a UTC midnight `Date` for the given calendar day. We only use
 * this as a container; downstream code should treat it as a date-only
 * value (the Prisma column is `@db.Date`).
 */
function utcMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Add N calendar days to a {year, month, day} tuple. Uses UTC math so
 * month/year boundaries and leap years work without manual branching;
 * DST only affects the local hour, never the calendar day.
 */
function shiftDay(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + delta);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export function logicalReportDate(input: LogicalDateInput): Date {
  const cutoff = input.cutoffHour ?? DEFAULT_CUTOFF;
  const tz = input.timezone ?? DEFAULT_TZ;
  const parts = localDateParts(input.now, tz);
  const effective =
    parts.hour < cutoff
      ? shiftDay(parts.year, parts.month, parts.day, -1)
      : { year: parts.year, month: parts.month, day: parts.day };
  return utcMidnight(effective.year, effective.month, effective.day);
}

/**
 * Expose the local calendar day for the given moment, independent of
 * the cutoff. Schedulers use this to compute "today" when they decide
 * whether something is overdue.
 */
export function localCalendarDate(
  now: Date,
  timezone: string = DEFAULT_TZ,
): Date {
  const parts = localDateParts(now, timezone);
  return utcMidnight(parts.year, parts.month, parts.day);
}

/**
 * `true` iff the submission at `now` would be considered a late
 * report under the policy: either it's past `cutoffHour` on its own
 * logical day's calendar day — i.e. the report is attached to today
 * but sent after the digest window — or its logical date is strictly
 * before the current local date.
 *
 * `deliveryHour` optionally overrides the hour used to decide "late
 * on the same day" and defaults to 19 (the daily-digest hour from the
 * active profile).
 */
export function isLateReport(
  now: Date,
  timezone: string = DEFAULT_TZ,
  deliveryHour: number = 19,
): boolean {
  const parts = localDateParts(now, timezone);
  const logical = logicalReportDate({ now, timezone });
  const today = localCalendarDate(now, timezone);
  if (logical.getTime() < today.getTime()) return true;
  return parts.hour >= deliveryHour;
}
