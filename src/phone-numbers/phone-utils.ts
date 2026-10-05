import { PhoneOperator } from '@prisma/client';

/**
 * Normalize a user-entered phone number into a safe canonical form.
 * We do not pretend to be a full libphonenumber implementation here —
 * this just strips whitespace and formatting characters, prefixes `+`
 * for Ukrainian numbers that forgot it, and keeps it under 32 chars.
 * The uniqueness guarantee at the DB level is on this normalized value.
 */
export function normalizePhone(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('number is required');
  // Keep leading + and digits only.
  const cleaned = trimmed.replace(/[^+\d]/g, '');
  if (!cleaned.replace(/\D/g, '').length) {
    throw new Error('number must contain digits');
  }
  const prefixed =
    cleaned.startsWith('+')
      ? cleaned
      : // Ukrainian local notation starts with 0; swap to +380.
        cleaned.startsWith('0')
        ? `+380${cleaned.slice(1)}`
        : `+${cleaned}`;
  if (prefixed.length > 32) {
    throw new Error('number is too long');
  }
  return prefixed;
}

/**
 * Mask a normalized phone number to just its last four digits for
 * audit and Discord reminder display.
 */
export function maskPhone(number: string): string {
  const digits = number.replace(/\D/g, '');
  if (digits.length <= 4) return `***${digits}`;
  return `***${digits.slice(-4)}`;
}

/**
 * Infer operator from a Ukrainian prefix as a convenience. Caller may
 * override with an explicit operator in the DTO; this is a hint only.
 */
export function inferUkrainianOperator(number: string): PhoneOperator | null {
  const digits = number.replace(/\D/g, '');
  if (!digits.startsWith('380') || digits.length < 5) return null;
  const code = digits.slice(3, 5); // "50", "67", "93" …
  if (['50', '66', '95', '99'].includes(code)) return PhoneOperator.VODAFONE;
  if (['67', '68', '96', '97', '98'].includes(code)) return PhoneOperator.KYIVSTAR;
  if (['63', '73', '93'].includes(code)) return PhoneOperator.LIFECELL;
  return PhoneOperator.OTHER;
}

/**
 * Compute the next three-month maintenance date, falling on the 1st
 * of the target month in the workspace timezone.
 */
export function computeNextMaintenanceDate(from: Date = new Date()): Date {
  const target = new Date(from);
  // Advance three calendar months and snap to the 1st at 09:00 UTC.
  target.setUTCMonth(target.getUTCMonth() + 3, 1);
  target.setUTCHours(9, 0, 0, 0);
  return target;
}
