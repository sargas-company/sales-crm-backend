/**
 * Resolve the B2 credentials used by backup / restore / prune
 * scripts. These are deliberately SEPARATE from the runtime key the
 * backend uses to read/write user files.
 *
 * Rules:
 *   - `B2_BACKUP_KEY_ID` + `B2_BACKUP_APP_KEY` are the primary
 *     source.
 *   - When `APP_ENV=local`, fall back to the general runtime
 *     `B2_KEY_ID` / `B2_APP_KEY` so developers can run `scripts/backup.ts`
 *     without juggling two key pairs on their laptop.
 *   - In any non-local environment, missing dedicated backup creds
 *     is a hard stop — we refuse to use the runtime key for backups.
 *
 * The runtime key MUST NOT be used by the live backend for backup
 * operations: the backup bucket (`DB_DUMPS`) is isolated from user
 * files on purpose.
 */
export interface BackupB2Credentials {
  keyId: string;
  appKey: string;
  usedFallback: boolean;
}

export function resolveBackupB2Credentials(
  env: NodeJS.ProcessEnv = process.env,
): BackupB2Credentials {
  const keyId = env.B2_BACKUP_KEY_ID ?? '';
  const appKey = env.B2_BACKUP_APP_KEY ?? '';
  if (keyId && appKey) {
    return { keyId, appKey, usedFallback: false };
  }

  const appEnv = env.APP_ENV ?? '';
  if (appEnv === 'local') {
    const fallbackId = env.B2_KEY_ID ?? '';
    const fallbackKey = env.B2_APP_KEY ?? '';
    if (fallbackId && fallbackKey) {
      return { keyId: fallbackId, appKey: fallbackKey, usedFallback: true };
    }
  }

  throw new Error(
    `Backup B2 credentials missing. Set B2_BACKUP_KEY_ID and B2_BACKUP_APP_KEY ` +
      `(fallback to B2_KEY_ID / B2_APP_KEY is allowed only when APP_ENV=local — current APP_ENV="${appEnv}"). ` +
      `The backend runtime key is not permitted for backup operations.`,
  );
}
