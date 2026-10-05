import { describe, it, expect } from '@jest/globals';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { AuthService } from './auth.service';
import { StorageBucket } from '../storage';

type StorageDouble = {
  calls: Array<{ bucket: StorageBucket; key: string }>;
  extractCalls: Array<string>;
  returnUrl?: string;
};

function makeDeps(
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    avatarUrl: string | null;
    avatarKey: string | null;
  },
  storage: StorageDouble,
) {
  const prisma = {
    user: {
      findUnique: async () => ({
        ...user,
        roleRef: null,
      }),
    },
  } as unknown as PrismaService;
  const jwt = {} as unknown as JwtService;
  const audit = {} as unknown as AuditEventService;
  const storageSvc = {
    getDownloadUrl: async (bucket: StorageBucket, key: string) => {
      storage.calls.push({ bucket, key });
      return storage.returnUrl ?? `signed://${bucket}/${key}`;
    },
    extractKeyFromLegacyUrl: (url: string) => {
      storage.extractCalls.push(url);
      // Minimal shim replicating the production parser.
      const marker = '/file/';
      const idx = url.indexOf(marker);
      if (idx < 0) return null;
      const rest = url.slice(idx + marker.length).split('?')[0];
      const slash = rest.indexOf('/');
      if (slash < 0) return null;
      return rest.slice(slash + 1);
    },
  };
  return new AuthService(prisma, jwt, audit, storageSvc as never);
}

describe('AuthService.getMe — avatar resolution branches', () => {
  it('uploaded avatar → mints a signed URL from AVATARS', async () => {
    const storage: StorageDouble = { calls: [], extractCalls: [] };
    const svc = makeDeps(
      {
        id: 'u1',
        email: 'u@x',
        firstName: 'U',
        lastName: 'U',
        avatarUrl: null,
        avatarKey: 'avatars/u1/123_abc.png',
      },
      storage,
    );
    const me = await svc.getMe('u1');
    expect(storage.calls).toEqual([
      { bucket: StorageBucket.AVATARS, key: 'avatars/u1/123_abc.png' },
    ]);
    expect(me.avatarUrl).toBe('signed://AVATARS/avatars/u1/123_abc.png');
    expect(storage.extractCalls).toEqual([]);
  });

  it('DiceBear preset → external URL passes through, no B2 call', async () => {
    const storage: StorageDouble = { calls: [], extractCalls: [] };
    const svc = makeDeps(
      {
        id: 'u2',
        email: 'u@x',
        firstName: 'U',
        lastName: 'U',
        avatarUrl: 'https://api.dicebear.com/x.svg?seed=Oliver',
        avatarKey: 'preset:m1',
      },
      storage,
    );
    const me = await svc.getMe('u2');
    expect(me.avatarUrl).toBe('https://api.dicebear.com/x.svg?seed=Oliver');
    expect(storage.calls).toEqual([]);
  });

  it('no avatar at all → null, no B2 call', async () => {
    const storage: StorageDouble = { calls: [], extractCalls: [] };
    const svc = makeDeps(
      {
        id: 'u3',
        email: 'u@x',
        firstName: 'U',
        lastName: 'U',
        avatarUrl: null,
        avatarKey: null,
      },
      storage,
    );
    const me = await svc.getMe('u3');
    expect(me.avatarUrl).toBeNull();
    expect(storage.calls).toEqual([]);
  });

  it('legacy row (permanent URL in avatarUrl, no key) → key is recovered + signed', async () => {
    const storage: StorageDouble = { calls: [], extractCalls: [] };
    const svc = makeDeps(
      {
        id: 'u4',
        email: 'u@x',
        firstName: 'U',
        lastName: 'U',
        avatarUrl:
          'https://f000.backblazeb2.com/file/sargas-crm-client-requests/avatars/u4/1700_x.png',
        avatarKey: null,
      },
      storage,
    );
    const me = await svc.getMe('u4');
    expect(storage.extractCalls.length).toBe(1);
    expect(storage.calls).toEqual([
      {
        bucket: StorageBucket.AVATARS,
        key: 'avatars/u4/1700_x.png',
      },
    ]);
    expect(me.avatarUrl).toBe('signed://AVATARS/avatars/u4/1700_x.png');
  });

  it('signed URL error degrades to null (not a 500)', async () => {
    const storage: StorageDouble = {
      calls: [],
      extractCalls: [],
    };
    const prisma = {
      user: {
        findUnique: async () => ({
          id: 'u5',
          email: 'u@x',
          firstName: 'U',
          lastName: 'U',
          avatarUrl: null,
          avatarKey: 'avatars/u5/k.png',
          roleRef: null,
        }),
      },
    } as unknown as PrismaService;
    const svc = new AuthService(
      prisma,
      {} as never,
      {} as never,
      {
        getDownloadUrl: async () => {
          throw new Error('bucket not configured');
        },
        extractKeyFromLegacyUrl: () => null,
      } as never,
    );
    const me = await svc.getMe('u5');
    expect(me.avatarUrl).toBeNull();
  });
});
