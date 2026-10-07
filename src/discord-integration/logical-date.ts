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
 * Local-wall-clock minute-of-day at the given moment in `timezone`.
 * Returned as `hour * 60 + minute` so the caller can compare against
 * a `HH:MM` deadline without parsing round-trips.
 */
function localMinuteOfDay(d: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const h = Number.parseInt(
    parts.find((p) => p.type === 'hour')?.value ?? '0',
    10,
  );
  const m = Number.parseInt(
    parts.find((p) => p.type === 'minute')?.value ?? '0',
    10,
  );
  return (h === 24 ? 0 : h) * 60 + m;
}

/**
 * Parse a `HH:MM` 24-hour string into minute-of-day. Any malformed
 * input falls back to 19:00 — the long-standing operational default.
 */
export function parseHHMM(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm ?? '');
  if (!m) return 19 * 60;
  return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
}

/**
 * `true` iff `now` is on or after `deadline` on its own local
 * calendar day, OR `now`'s logical report date is strictly before
 * today's local calendar day. The `deadline` is the daily-digest
 * cutoff from the active profile (`dailyDigestAt`, e.g. "19:00") and
 * the predicate is the single source of truth for "late vs. normal":
 *
 *   now < deadline              → NOT late (digest will pick it up)
 *   now >= deadline              → late     (digest has already fired
 *                                            or is about to; this
 *                                            report is after the cut)
 *   logical(reportDate) < today → late     (back-dated report)
 *
 * Using a HH:MM deadline (not just an hour) and routing through the
 * profile's own timezone keeps DST correct and keeps late-callers and
 * daily-digest-callers in lockstep — no 59-second race window where
 * one path thinks it's late and the other picks it up anyway.
 */
export function isLateReport(
  now: Date,
  timezone: string = DEFAULT_TZ,
  deliveryAt: string | number = '19:00',
): boolean {
  const logical = logicalReportDate({ now, timezone });
  const today = localCalendarDate(now, timezone);
  if (logical.getTime() < today.getTime()) return true;
  const deadlineMinutes =
    typeof deliveryAt === 'number'
      ? Math.max(0, Math.min(23 * 60 + 59, deliveryAt * 60))
      : parseHHMM(deliveryAt);
  return localMinuteOfDay(now, timezone) >= deadlineMinutes;
}
