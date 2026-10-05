/* eslint-disable no-console */
/**
 * Portfolio asset storage migration utility.
 *
 * Copies existing `portfolio/*` objects from the legacy bucket
 * (`CLIENT_REQUESTS` or `INVOICES`, whichever the setting pointed at)
 * into the new dedicated `PORTFOLIO` bucket. Keys are preserved as-is.
 *
 * Idempotent. Dry-run by default — pass `--apply` to actually copy.
 *
 *   # Dry-run against the current setting:
 *   npx ts-node scripts/migrate-portfolio-storage.ts
 *
 *   # Explicit source bucket:
 *   npx ts-node scripts/migrate-portfolio-storage.ts --source=CLIENT_REQUESTS
 *
 *   # When ready, after inspecting the dry-run report:
 *   npx ts-node scripts/migrate-portfolio-storage.ts --apply
 *
 * The script never deletes anything on the source side. B2 downloads
 * the object into memory and re-uploads to the destination; buffers
 * are released after each file.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import B2 = require('backblaze-b2');

interface Args {
  source: 'CLIENT_REQUESTS' | 'INVOICES';
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const sourceFlag = argv.find((a) => a.startsWith('--source='));
  const source = (sourceFlag?.split('=')[1] ?? 'CLIENT_REQUESTS').toUpperCase();
  if (source !== 'CLIENT_REQUESTS' && source !== 'INVOICES') {
    throw new Error('--source must be CLIENT_REQUESTS or INVOICES');
  }
  return { source: source as Args['source'], apply };
}

async function main() {
  const args = parseArgs();
  const prisma = new PrismaClient();

  const srcEnvId =
    args.source === 'CLIENT_REQUESTS'
      ? 'B2_BUCKET_CLIENT_REQUESTS_ID'
      : 'B2_BUCKET_INVOICES_ID';

  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APP_KEY;
  const srcBucketId = process.env[srcEnvId];
  const dstBucketId = process.env.B2_BUCKET_PORTFOLIO_ID;
  if (!keyId || !appKey || !srcBucketId || !dstBucketId) {
    throw new Error(
      `Missing env: B2_KEY_ID / B2_APP_KEY / ${srcEnvId} / B2_BUCKET_PORTFOLIO_ID`,
    );
  }

  const b2 = new B2({ applicationKeyId: keyId, applicationKey: appKey });
  await b2.authorize();

  const assets = await prisma.portfolioAsset.findMany({
    select: { id: true, storageKey: true },
  });
  console.log(`[portfolio-migrate] ${assets.length} assets rows in DB`);

  let copied = 0;
  let skipped = 0;
  let missingSrc = 0;
  let alreadyAtDst = 0;

  for (const a of assets) {
    // Check destination first for idempotence.
    const atDst = await b2
      .listFileNames({
        bucketId: dstBucketId,
        startFileName: a.storageKey,
        maxFileCount: 1,
        delimiter: '',
        prefix: a.storageKey,
      })
      .then((r) => r.data.files.some((f) => f.fileName === a.storageKey))
      .catch(() => false);
    if (atDst) {
      alreadyAtDst++;
      continue;
    }

    const atSrc = await b2
      .listFileNames({
        bucketId: srcBucketId,
        startFileName: a.storageKey,
        maxFileCount: 1,
        delimiter: '',
        prefix: a.storageKey,
      })
      .then((r) => r.data.files.find((f) => f.fileName === a.storageKey))
      .catch(() => undefined);
    if (!atSrc) {
      missingSrc++;
      continue;
    }

    if (!args.apply) {
      skipped++;
      continue;
    }

    const dl = await b2.downloadFileById({
      fileId: atSrc.fileId,
      responseType: 'arraybuffer',
    });
    const buf = Buffer.from(dl.data as ArrayBuffer);

    const { data: upUrl } = await b2.getUploadUrl({ bucketId: dstBucketId });
    await b2.uploadFile({
      uploadUrl: upUrl.uploadUrl,
      uploadAuthToken: upUrl.authorizationToken,
      fileName: a.storageKey,
      data: buf,
      mime: atSrc.contentType ?? 'application/octet-stream',
      contentLength: buf.length,
    });
    copied++;
  }

  await prisma.$disconnect();

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? 'apply' : 'dry-run',
        source: args.source,
        totalAssets: assets.length,
        copied,
        alreadyAtDst,
        missingSrc,
        plannedCopy: args.apply ? 0 : assets.length - alreadyAtDst - missingSrc,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[portfolio-migrate] FAILED', err);
  process.exit(1);
});
