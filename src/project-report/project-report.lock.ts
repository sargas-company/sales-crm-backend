/**
 * Shared Postgres advisory-lock key for a given (project, reportDate)
 * tuple. Used by both the MANUAL (CRM) and DISCORD (slash-command)
 * create flows so a concurrent create from one side cannot slip in
 * between the cross-source collision check and the row insert.
 *
 * 31-bit FNV-1a — stays within `int4` range so `pg_advisory_xact_lock`
 * accepts it in the single-argument form.
 */
export function projectReportLockKey(projectId: string, reportDate: Date): number {
  const seed = `${projectId}::${reportDate.toISOString().slice(0, 10)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h & 0x7fffffff;
}
