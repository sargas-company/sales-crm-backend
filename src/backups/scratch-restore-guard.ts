import { parseDatabaseUrl } from './backup-runner';

/**
 * Guard that decides whether a given `--restore-to` DATABASE_URL is
 * safe to receive a scratch restore. The rules are deliberately
 * strict and shared with its tests so a product-level mistake cannot
 * widen them in isolation.
 */
export interface ScratchGuardResult {
  ok: boolean;
  message?: string;
  host?: string;
  database?: string;
}

const SCRATCH_SUFFIX_REGEX = /_restore_|_scratch/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function evaluateScratchTarget(input: string): ScratchGuardResult {
  let parsed;
  try {
    parsed = parseDatabaseUrl(input);
  } catch {
    return { ok: false, message: '--restore-to is not a valid DATABASE_URL' };
  }
  const { host, database } = parsed;
  if (!LOCAL_HOSTS.has(host)) {
    return {
      ok: false,
      host,
      database,
      message: `--restore-to host "${host}" is not local; scratch restores only run against localhost / 127.0.0.1 / ::1`,
    };
  }
  if (!SCRATCH_SUFFIX_REGEX.test(database)) {
    return {
      ok: false,
      host,
      database,
      message: `--restore-to database "${database}" must contain "_restore_" or "_scratch" to make the scratch intent explicit`,
    };
  }
  return { ok: true, host, database };
}
