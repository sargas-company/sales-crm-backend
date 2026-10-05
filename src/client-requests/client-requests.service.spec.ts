import { describe, it, expect, beforeEach } from '@jest/globals';

import { ClientRequestsService } from './client-requests.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { StorageBucket, StorageService, type StoredFileMetadata } from '../storage';

/**
 * Regression tests for the file-layer stabilisation on
 * `/client-requests`:
 *   - new rows must NOT persist a permanent B2 URL;
 *   - legacy rows that still store a `url` must still be downloadable;
 *   - the file-only path lives in the CLIENT_REQUESTS bucket.
 */

interface Capture {
  upload: Array<{ bucket: StorageBucket; fileName: string }>;
  signed: Array<{ bucket: StorageBucket; fileName: string }>;
  deleted: Array<{ bucket: StorageBucket; fileName: string }>;
  prismaWrites: Array<{ op: string; data: unknown }>;
}

function build(capture: Capture, overrides: {
  initialFiles?: StoredFileMetadata[];
} = {}) {
  const requestRow = {
    id: 'cr-1',
    name: 'John',
    createdAt: new Date('2026-10-04T00:00:00Z'),
    files: overrides.initialFiles ?? [],
    services: [],
    email: 'j@x',
    company: null,
    phone: null,
    phoneCountry: null,
    message: null,
  };
  const prisma = {
    clientRequest: {
      create: async ({ data }: { data: unknown }) => {
        capture.prismaWrites.push({ op: 'create', data });
        return requestRow;
      },
      update: async ({ data }: { data: unknown }) => {
        capture.prismaWrites.push({ op: 'update', data });
        return requestRow;
      },
      findUnique: async () => requestRow,
      delete: async () => requestRow,
    },
  } as unknown as PrismaService;
  const storage = {
    upload: async (opts: { bucket: StorageBucket; fileName: string }) => {
      capture.upload.push({ bucket: opts.bucket, fileName: opts.fileName });
      return { fileId: 'fid-' + capture.upload.length, key: opts.fileName };
    },
    getDownloadUrl: async (bucket: StorageBucket, fileName: string) => {
      capture.signed.push({ bucket, fileName });
      return `signed://${bucket}/${fileName}`;
    },
    deleteByName: async (bucket: StorageBucket, fileName: string) => {
      capture.deleted.push({ bucket, fileName });
    },
    extractKeyFromLegacyUrl: (url: string) => {
      const marker = '/file/';
      const idx = url.indexOf(marker);
      if (idx < 0) return null;
      const rest = url.slice(idx + marker.length).split('?')[0];
      const slash = rest.indexOf('/');
      if (slash < 0) return null;
      return rest
        .slice(slash + 1)
        .split('/')
        .map((seg) => decodeURIComponent(seg))
        .join('/');
    },
  } as unknown as StorageService;
  const notifications = {
    createEvent: async () => undefined,
  } as unknown as NotificationService;
  return new ClientRequestsService(prisma, notifications, storage);
}

describe('ClientRequestsService file handling', () => {
  let capture: Capture;

  beforeEach(() => {
    capture = { upload: [], signed: [], deleted: [], prismaWrites: [] };
  });

  it('new row persists key, not permanent url', async () => {
    const svc = build(capture);
    await svc.create(
      {
        name: 'John',
        email: 'j@x',
      } as never,
      [
        {
          originalName: 'proof.png',
          buffer: Buffer.from('x'),
          mimetype: 'image/png',
          size: 1,
        },
      ],
    );
    // Only CLIENT_REQUESTS bucket was touched.
    expect(capture.upload.every((u) => u.bucket === StorageBucket.CLIENT_REQUESTS)).toBe(
      true,
    );
    // The persisted `files` row carries fileName (= key) but NO `url`.
    const updateWrite = capture.prismaWrites.find((w) => w.op === 'update');
    expect(updateWrite).toBeDefined();
    const files = (updateWrite!.data as { files: StoredFileMetadata[] }).files;
    expect(files.length).toBe(1);
    expect(files[0].fileName.length).toBeGreaterThan(0);
    expect((files[0] as { url?: unknown }).url).toBeUndefined();
  });

  it('legacy row (url only, no fileName) → download URL is signed from recovered key', async () => {
    const legacy: StoredFileMetadata[] = [
      {
        originalName: 'legacy.pdf',
        fileName: '',
        fileId: 'legacy-fid',
        mimetype: 'application/pdf',
        size: 123,
        url: 'https://f000.backblazeb2.com/file/sargas-crm-client-requests/old%20folder/legacy.pdf',
      } as unknown as StoredFileMetadata,
    ];
    const svc = build(capture, { initialFiles: legacy });
    const urls = await svc.getFilesDownloadUrls('cr-1');
    expect(urls.length).toBe(1);
    expect(urls[0].url).toBe(
      'signed://CLIENT_REQUESTS/old folder/legacy.pdf',
    );
    expect(capture.signed.length).toBe(1);
    expect(capture.signed[0]!.bucket).toBe(StorageBucket.CLIENT_REQUESTS);
  });

  it('new-shape row (fileName set, no url) → download URL signed from the stored key', async () => {
    const svc = build(capture, {
      initialFiles: [
        {
          originalName: 'ok.pdf',
          fileName: 'John/2026-10-04-ok-abc.pdf',
          fileId: 'f-1',
          mimetype: 'application/pdf',
          size: 1,
        },
      ],
    });
    const urls = await svc.getFilesDownloadUrls('cr-1');
    expect(urls[0].url).toBe(
      'signed://CLIENT_REQUESTS/John/2026-10-04-ok-abc.pdf',
    );
  });
});
