import { describe, it, expect } from '@jest/globals';
import { resolveBackupB2Credentials } from './backup-credentials';

describe('resolveBackupB2Credentials', () => {
  it('returns the dedicated backup key when both envs are set', () => {
    const r = resolveBackupB2Credentials({
      APP_ENV: 'production',
      B2_BACKUP_KEY_ID: 'bk',
      B2_BACKUP_APP_KEY: 'bs',
      B2_KEY_ID: 'runtime',
      B2_APP_KEY: 'runtime-secret',
    });
    expect(r.keyId).toBe('bk');
    expect(r.appKey).toBe('bs');
    expect(r.usedFallback).toBe(false);
  });

  it('falls back to runtime creds only when APP_ENV=local', () => {
    const r = resolveBackupB2Credentials({
      APP_ENV: 'local',
      B2_KEY_ID: 'runtime',
      B2_APP_KEY: 'secret',
    });
    expect(r.keyId).toBe('runtime');
    expect(r.usedFallback).toBe(true);
  });

  it('throws in production when dedicated creds are missing', () => {
    expect(() =>
      resolveBackupB2Credentials({
        APP_ENV: 'production',
        B2_KEY_ID: 'runtime',
        B2_APP_KEY: 'secret',
      }),
    ).toThrow(/B2_BACKUP_KEY_ID.*B2_BACKUP_APP_KEY/);
  });

  it('throws in staging too (not just production)', () => {
    expect(() =>
      resolveBackupB2Credentials({
        APP_ENV: 'staging',
        B2_KEY_ID: 'runtime',
        B2_APP_KEY: 'secret',
      }),
    ).toThrow(/B2_BACKUP_KEY_ID/);
  });

  it('throws in local when neither dedicated nor runtime creds exist', () => {
    expect(() => resolveBackupB2Credentials({ APP_ENV: 'local' })).toThrow(
      /B2_BACKUP_KEY_ID/,
    );
  });
});
