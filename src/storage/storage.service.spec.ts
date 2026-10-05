import { describe, it, expect } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';

import { StorageBucket } from './storage.types';
import { StorageService } from './storage.service';

function makeService(env: Record<string, string> = {}): StorageService {
  const config = {
    getOrThrow: (key: string) => {
      if (env[key] === undefined) {
        throw new Error(`Missing env ${key}`);
      }
      return env[key];
    },
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new StorageService(config);
}

const DEFAULT_B2_ENV = {
  B2_KEY_ID: 'kid',
  B2_APP_KEY: 'app',
};

describe('StorageService.extractKeyFromLegacyUrl', () => {
  const svc = makeService(DEFAULT_B2_ENV);

  it('decodes a nested key', () => {
    const url =
      'https://f000.backblazeb2.com/file/sargas-crm-client-requests/John%20Doe%20-%20May%2001%2C%202026%20(abc12345)/2026-05-01-screenshot.png';
    expect(svc.extractKeyFromLegacyUrl(url)).toBe(
      'John Doe - May 01, 2026 (abc12345)/2026-05-01-screenshot.png',
    );
  });

  it('ignores Authorization query parameter', () => {
    const url =
      'https://f000.backblazeb2.com/file/sargas-crm-invoices/Invoice%20X.pdf?Authorization=abc.def';
    expect(svc.extractKeyFromLegacyUrl(url)).toBe('Invoice X.pdf');
  });

  it('returns null for unknown shape', () => {
    expect(svc.extractKeyFromLegacyUrl('not-a-url')).toBeNull();
    expect(svc.extractKeyFromLegacyUrl('')).toBeNull();
    expect(
      svc.extractKeyFromLegacyUrl('https://example.com/nothing-here'),
    ).toBeNull();
  });

  it('handles percent-encoded slashes within a path segment', () => {
    const url =
      'https://f000.backblazeb2.com/file/sargas-crm-portfolio/portfolio/ca82/images/1791064736890_file%20name.md';
    expect(svc.extractKeyFromLegacyUrl(url)).toBe(
      'portfolio/ca82/images/1791064736890_file name.md',
    );
  });
});

describe('StorageService bucket config lazy resolution', () => {
  it('throws a clear error when PORTFOLIO env is missing', async () => {
    const svc = makeService(DEFAULT_B2_ENV);
    await expect(
      svc.getDownloadUrl(StorageBucket.PORTFOLIO, 'key'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    try {
      await svc.getDownloadUrl(StorageBucket.PORTFOLIO, 'key');
    } catch (e) {
      expect((e as InternalServerErrorException).message).toContain(
        'B2_BUCKET_PORTFOLIO_ID',
      );
      expect((e as InternalServerErrorException).message).not.toContain(
        'CLIENT_REQUESTS',
      );
    }
  });

  it('throws a clear error when AVATARS env is missing', async () => {
    const svc = makeService(DEFAULT_B2_ENV);
    await expect(
      svc.getDownloadUrl(StorageBucket.AVATARS, 'avatars/u/x.png'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    try {
      await svc.getDownloadUrl(StorageBucket.AVATARS, 'k');
    } catch (e) {
      expect((e as InternalServerErrorException).message).toContain(
        'B2_BUCKET_AVATARS_ID',
      );
    }
  });

  it('instantiation does NOT require portfolio / avatars env', () => {
    expect(() => makeService(DEFAULT_B2_ENV)).not.toThrow();
  });
});
