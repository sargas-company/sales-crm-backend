/**
 * Centralised audit redaction / diff helpers.
 *
 * The audit stream never stores secret values. Any `metadata` passed
 * into `AuditEventService.record` goes through this file first — any
 * key that even smells like a secret is dropped, and raw string values
 * that exceed a safety threshold are truncated.
 *
 * There are two public helpers:
 *   - `redactMetadata(input)` — drops forbidden keys, truncates giant
 *     strings. Use for the `metadata` column.
 *   - `safeDiff(before, after, options)` — produces a structured
 *     `{field: {before, after}}` object with the same redaction rules
 *     applied field-by-field. Secret-ish fields collapse into
 *     `{changed: true}` so we record the fact of change without the
 *     value. Use for the `changes` column.
 */

// Forbidden by key name (case-insensitive, matches anywhere in the key).
const REDACTED_KEY_RE =
  /password|passwordhash|token|refresh|secret|hash|otp|totp|recovery|cookie|session|cipher|iv|salt|authorization|bearer|apikey|api_key/i;

// Keys we always treat as sensitive even outside the regex above.
const EXPLICIT_SECRET_KEYS = new Set([
  'passwordEncrypted',
  'totpEncrypted',
  'totpSeed',
  'recoveryCodes',
  'encryptionKey',
  'masterKey',
  'content',
]);

const MAX_STRING_LEN = 240;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isSensitiveKey = (key: string) =>
  REDACTED_KEY_RE.test(key) || EXPLICIT_SECRET_KEYS.has(key);

const truncate = (value: unknown): unknown => {
  if (typeof value === 'string' && value.length > MAX_STRING_LEN) {
    return `${value.slice(0, MAX_STRING_LEN)}…[truncated]`;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) {
      return [...value.slice(0, 50).map(truncate), `…[+${value.length - 50} more]`];
    }
    return value.map(truncate);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncate(v);
    return out;
  }
  return value;
};

/**
 * Drop forbidden keys, truncate oversize strings. Nested objects/arrays
 * are walked recursively. Returns `undefined` if the input is nullish
 * so the caller can store Prisma `JsonNull`.
 */
export function redactMetadata(
  input: Record<string, unknown> | undefined | null,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isSensitiveKey(key)) continue;
    if (isPlainObject(value)) {
      const nested = redactMetadata(value);
      if (nested !== undefined) out[key] = nested;
    } else {
      out[key] = truncate(value);
    }
  }
  return out;
}

export type DiffField = { before: unknown; after: unknown } | { changed: true };
export type SafeChanges = Record<string, DiffField>;

interface DiffOptions {
  /** Extra field names that must be reported as `{changed: true}` even
   *  if the key wouldn't trip `REDACTED_KEY_RE`. Use for things like
   *  `encryptedPayload` or `attachmentBlob`. */
  sensitiveFields?: string[];
  /** Field names to drop from the diff entirely (never report the
   *  change). Rare — use for internal bookkeeping. */
  ignore?: string[];
}

/**
 * Build a sanitised diff of two shallow objects.
 *   - Equal values are omitted.
 *   - Secret-ish keys collapse to `{changed: true}`.
 *   - Oversize values are truncated.
 *   - Returns `undefined` if nothing changed.
 */
export function safeDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  options: DiffOptions = {},
): SafeChanges | undefined {
  const b = before ?? {};
  const a = after ?? {};
  const sensitive = new Set(options.sensitiveFields ?? []);
  const ignore = new Set(options.ignore ?? []);
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: SafeChanges = {};
  for (const key of keys) {
    if (ignore.has(key)) continue;
    const bv = b[key];
    const av = a[key];
    if (equalShallow(bv, av)) continue;
    if (isSensitiveKey(key) || sensitive.has(key)) {
      out[key] = { changed: true };
      continue;
    }
    out[key] = { before: truncate(bv) ?? null, after: truncate(av) ?? null };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function equalShallow(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object'
  ) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Compare two sets of permission keys and report additions/removals.
 * Shapes the diff the frontend's "Permission changes" renderer
 * expects.
 */
export function permissionDiff(
  before: string[],
  after: string[],
): { added: string[]; removed: string[] } | undefined {
  const bs = new Set(before);
  const as_ = new Set(after);
  const added = after.filter((p) => !bs.has(p)).sort();
  const removed = before.filter((p) => !as_.has(p)).sort();
  if (added.length === 0 && removed.length === 0) return undefined;
  return { added, removed };
}
