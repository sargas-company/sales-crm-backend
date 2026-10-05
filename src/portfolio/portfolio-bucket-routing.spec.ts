import { describe, it, expect } from '@jest/globals';
import { PortfolioService } from './portfolio.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { SettingsService } from '../settings/settings.service';
import { StorageBucket, StorageService } from '../storage';

/**
 * Regression test: portfolio asset signed URLs are minted exclusively
 * from the PORTFOLIO bucket (not CLIENT_REQUESTS / INVOICES). The
 * runtime toggle `PORTFOLIO_STORAGE_BUCKET` was retired during the
 * file-layer stabilisation — this test anchors that decision.
 */
describe('Portfolio bucket routing', () => {
  it('signAssetDownload asks StorageService for the PORTFOLIO bucket', async () => {
    const calls: Array<{ bucket: StorageBucket; key: string }> = [];
    const prisma = {
      portfolioAsset: {
        findUnique: async () => ({
          id: 'a1',
          storageKey: 'portfolio/item-1/images/123_x.png',
          item: { id: 'item-1' },
        }),
      },
    } as unknown as PrismaService;
    const storage = {
      getDownloadUrl: async (bucket: StorageBucket, key: string) => {
        calls.push({ bucket, key });
        return `signed://${bucket}/${key}`;
      },
    } as unknown as StorageService;
    const settings = {} as unknown as SettingsService;
    const audit = {} as unknown as AuditEventService;
    const svc = new PortfolioService(prisma, audit, storage, settings);
    const url = await svc.signAssetDownload('a1');
    expect(url).toBe(
      'signed://PORTFOLIO/portfolio/item-1/images/123_x.png',
    );
    expect(calls).toEqual([
      {
        bucket: StorageBucket.PORTFOLIO,
        key: 'portfolio/item-1/images/123_x.png',
      },
    ]);
  });
});
