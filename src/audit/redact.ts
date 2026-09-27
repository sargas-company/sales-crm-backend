// Any object key whose name matches this pattern is dropped from an
// `AuditLog.summary` payload before write (spec §3.4). The audit log
// is intended to record shape/diff information, not secret values —
// this filter is the last-line defence against a caller accidentally
// passing a password, hash, token, refresh-token or bare "secret"
// through the summary field.
const REDACTED_KEY_RE = /password|passwordhash|token|refresh|secret|hash/i;

export function redactSummary(
  value: Record<string, unknown> | undefined | null,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (REDACTED_KEY_RE.test(key)) continue;
    out[key] = v;
  }
  return out;
}
