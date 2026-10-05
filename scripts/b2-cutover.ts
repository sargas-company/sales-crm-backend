/* eslint-disable no-console */
/**
 * B2 cutover — guarded copy of every DB-referenced storage key from a
 * source B2 account into the production (destination) B2 account.
 *
 *   Modes:
 *     --dry-run (default)  → walk every planned key, probe source +
 *                            destination, classify, print report.
 *     --apply              → perform the planned copies ONLY. No
 *                            delete. No DB write. Idempotent.
 *     --verify             → re-probe after apply: destination must
 *                            have every expected key, with matching
 *                            size + sha1 hash.
 *
 *   Classification per key:
 *     sourceMissing     → source lacks the object; error, surfaces in report.
 *     alreadyPresent    → destination has it, size + sha1 match; skip.
 *     plannedCopy       → destination lacks it; counted; copied on --apply.
 *     conflict          → destination has it but size or sha1 differs
 *                         from source; NEVER overwritten automatically.
 *     verified          → post-apply, size + sha1 match on destination.
 *
 * Required env (same key opens both source and destination — ensure
 * both accounts share capabilities or run twice with swapped keys):
 *     B2_KEY_ID / B2_APP_KEY           — source account.
 *     B2_DEST_KEY_ID / B2_DEST_APP_KEY — destination account.
 *     B2_BUCKET_*_ID / B2_BUCKET_*_NAME on source side.
 *     B2_DEST_BUCKET_*_ID              on destination side (same bucket roles).
 *
 * This script performs NO B2 writes unless `--apply` is passed. It
 * performs NO DB writes.
 *
 *   npx ts-node scripts/b2-cutover.ts                   # dry-run
 *   npx ts-node scripts/b2-cutover.ts --apply           # copy
 *   npx ts-node scripts/b2-cutover.ts --verify          # re-check
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import B2 = require('backblaze-b2');

type BucketRole = 'AVATARS' | 'PORTFOLIO' | 'INVOICES' | 'CLIENT_REQUESTS';

interface PlannedKey {
  role: BucketRole;
  source: string;         // which DB field produced the key
  key: string;             // B2 fileName
}

interface ClassifiedKey extends PlannedKey {
  srcSize?: number;
  srcSha1?: string;
  dstSize?: number;
  dstSha1?: string;
  verdict:
    | 'sourceMissing'
    | 'alreadyPresent'
    | 'plannedCopy'
    | 'conflict'
    | 'verified';
  copied?: boolean;
  error?: string;
}

interface BucketPair {
  role: BucketRole;
  srcBucketId: string;
  dstBucketId: string;
  srcBucketName?: string;
}

interface Mode {
  apply: boolean;
  verify: boolean;
}

function parseMode(argv: string[]): Mode {
  const apply = argv.includes('--apply');
  const verify = argv.includes('--verify');
  if (apply && verify) {
    throw new Error('--apply and --verify are mutually exclusive');
  }
  return { apply, verify };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name];
}

async function enumerateKeys(prisma: PrismaClient): Promise<PlannedKey[]> {
  const out: PlannedKey[] = [];

  const users = await prisma.user.findMany({
    where: { avatarKey: { not: null } },
    select: { avatarKey: true },
  });
  for (const u of users) {
    const k = u.avatarKey!;
    if (k.startsWith('preset:')) continue;
    out.push({ role: 'AVATARS', source: 'User.avatarKey', key: k });
  }

  const port = await prisma.portfolioAsset.findMany({ select: { storageKey: true } });
  for (const p of port) out.push({ role: 'PORTFOLIO', source: 'PortfolioAsset.storageKey', key: p.storageKey });

  const inv = await prisma.invoice.findMany({
    where: { pdfUrl: { not: null } },
    select: { pdfUrl: true },
  });
  for (const i of inv) out.push({ role: 'INVOICES', source: 'Invoice.pdfUrl', key: i.pdfUrl! });

  const cr = await prisma.clientRequest.findMany({ select: { files: true } });
  for (const row of cr) {
    const files = Array.isArray(row.files) ? (row.files as Array<Record<string, unknown>>) : [];
    for (const f of files) {
      if (typeof f.storageKey === 'string') {
        out.push({ role: 'CLIENT_REQUESTS', source: 'ClientRequest.files[]', key: f.storageKey });
      }
    }
  }

  // TimeOff.attachmentKey — go to CLIENT_REQUESTS historically (see
  // scripts/normalize-file-urls.ts). Flagged source so the report
  // highlights them.
  const to = await prisma.timeOff.findMany({
    where: { attachmentKey: { not: null } },
    select: { attachmentKey: true },
  });
  for (const t of to) {
    out.push({ role: 'CLIENT_REQUESTS', source: 'TimeOff.attachmentKey', key: t.attachmentKey! });
  }

  return out;
}

async function probe(
  client: InstanceType<typeof B2>,
  bucketId: string,
  key: string,
): Promise<{ size: number; sha1: string } | null> {
  try {
    const r = await client.listFileNames({
      bucketId,
      startFileName: key,
      maxFileCount: 1,
      delimiter: '',
      prefix: key,
    });
    const file = r.data.files.find((f: { fileName: string }) => f.fileName === key);
    if (!file) return null;
    return {
      size: Number((file as { contentLength?: number; size?: number }).contentLength ?? (file as { size?: number }).size ?? 0),
      sha1: String((file as { contentSha1?: string }).contentSha1 ?? ''),
    };
  } catch {
    return null;
  }
}

async function copyOne(
  srcClient: InstanceType<typeof B2>,
  dstClient: InstanceType<typeof B2>,
  srcBucketId: string,
  dstBucketId: string,
  key: string,
): Promise<void> {
  const list = await srcClient.listFileNames({
    bucketId: srcBucketId,
    startFileName: key,
    maxFileCount: 1,
    delimiter: '',
    prefix: key,
  });
  const file = list.data.files.find((f: { fileName: string }) => f.fileName === key);
  if (!file) throw new Error(`source object missing at copy time: ${key}`);
  const dl = await srcClient.downloadFileById({
    fileId: (file as { fileId: string }).fileId,
    responseType: 'arraybuffer',
  });
  const buf = Buffer.from(dl.data as ArrayBuffer);
  const { data: upUrl } = await dstClient.getUploadUrl({ bucketId: dstBucketId });
  await dstClient.uploadFile({
    uploadUrl: upUrl.uploadUrl,
    uploadAuthToken: upUrl.authorizationToken,
    fileName: key,
    data: buf,
    mime: (file as { contentType?: string }).contentType ?? 'application/octet-stream',
    contentLength: buf.length,
  });
}

async function main() {
  const mode = parseMode(process.argv.slice(2));

  // Credentials — read, but only authorize when we actually run.
  const srcKey = requireEnv('B2_KEY_ID');
  const srcSecret = requireEnv('B2_APP_KEY');
  const dstKey = requireEnv('B2_DEST_KEY_ID');
  const dstSecret = requireEnv('B2_DEST_APP_KEY');

  const buckets: BucketPair[] = [
    {
      role: 'AVATARS',
      srcBucketId: requireEnv('B2_BUCKET_AVATARS_ID'),
      dstBucketId: requireEnv('B2_DEST_BUCKET_AVATARS_ID'),
      srcBucketName: optionalEnv('B2_BUCKET_AVATARS_NAME'),
    },
    {
      role: 'PORTFOLIO',
      srcBucketId: requireEnv('B2_BUCKET_PORTFOLIO_ID'),
      dstBucketId: requireEnv('B2_DEST_BUCKET_PORTFOLIO_ID'),
    },
    {
      role: 'INVOICES',
      srcBucketId: requireEnv('B2_BUCKET_INVOICES_ID'),
      dstBucketId: requireEnv('B2_DEST_BUCKET_INVOICES_ID'),
    },
    {
      role: 'CLIENT_REQUESTS',
      srcBucketId: requireEnv('B2_BUCKET_CLIENT_REQUESTS_ID'),
      dstBucketId: requireEnv('B2_DEST_BUCKET_CLIENT_REQUESTS_ID'),
    },
  ];
  const bucketOf: Record<BucketRole, BucketPair> = Object.fromEntries(
    buckets.map((b) => [b.role, b]),
  ) as Record<BucketRole, BucketPair>;

  const prisma = new PrismaClient();
  const srcClient = new B2({ applicationKeyId: srcKey, applicationKey: srcSecret });
  const dstClient = new B2({ applicationKeyId: dstKey, applicationKey: dstSecret });
  await srcClient.authorize();
  await dstClient.authorize();

  const planned = await enumerateKeys(prisma);
  const classified: ClassifiedKey[] = [];

  for (const k of planned) {
    const bucket = bucketOf[k.role];
    const srcHead = await probe(srcClient, bucket.srcBucketId, k.key);
    const dstHead = await probe(dstClient, bucket.dstBucketId, k.key);

    if (!srcHead) {
      classified.push({
        ...k,
        verdict: 'sourceMissing',
        error: `source bucket ${bucket.role} has no object with name "${k.key}"`,
      });
      continue;
    }
    if (!dstHead) {
      classified.push({
        ...k,
        srcSize: srcHead.size,
        srcSha1: srcHead.sha1,
        verdict: 'plannedCopy',
      });
      continue;
    }
    const matches =
      dstHead.size === srcHead.size &&
      (srcHead.sha1 === '' || dstHead.sha1 === '' || dstHead.sha1 === srcHead.sha1);
    classified.push({
      ...k,
      srcSize: srcHead.size,
      srcSha1: srcHead.sha1,
      dstSize: dstHead.size,
      dstSha1: dstHead.sha1,
      verdict: matches ? 'alreadyPresent' : 'conflict',
    });
  }

  if (mode.apply) {
    for (const row of classified) {
      if (row.verdict !== 'plannedCopy') continue;
      try {
        const bucket = bucketOf[row.role];
        await copyOne(srcClient, dstClient, bucket.srcBucketId, bucket.dstBucketId, row.key);
        const dstHead = await probe(dstClient, bucket.dstBucketId, row.key);
        if (
          dstHead &&
          dstHead.size === row.srcSize &&
          (row.srcSha1 === '' || dstHead.sha1 === '' || dstHead.sha1 === row.srcSha1)
        ) {
          row.copied = true;
          row.verdict = 'verified';
          row.dstSize = dstHead.size;
          row.dstSha1 = dstHead.sha1;
        } else {
          row.copied = false;
          row.verdict = 'conflict';
          row.error = 'post-copy verification failed';
          row.dstSize = dstHead?.size;
          row.dstSha1 = dstHead?.sha1;
        }
      } catch (err) {
        row.copied = false;
        row.error = (err as Error).message.slice(0, 300);
        row.verdict = 'conflict';
      }
    }
  }

  if (mode.verify) {
    for (const row of classified) {
      if (row.verdict !== 'alreadyPresent' && row.verdict !== 'verified') continue;
      const bucket = bucketOf[row.role];
      const dstHead = await probe(dstClient, bucket.dstBucketId, row.key);
      if (
        dstHead &&
        row.srcSize !== undefined &&
        dstHead.size === row.srcSize &&
        (row.srcSha1 === '' || dstHead.sha1 === '' || dstHead.sha1 === row.srcSha1)
      ) {
        row.verdict = 'verified';
      } else {
        row.verdict = 'conflict';
        row.error = 'verify pass found a mismatch';
      }
    }
  }

  const summary = {
    mode: mode.apply ? 'apply' : mode.verify ? 'verify' : 'dry-run',
    totalPlanned: classified.length,
    found: classified.filter((c) => c.verdict !== 'sourceMissing').length,
    sourceMissing: classified.filter((c) => c.verdict === 'sourceMissing').length,
    alreadyPresent: classified.filter((c) => c.verdict === 'alreadyPresent').length,
    plannedCopy: classified.filter((c) => c.verdict === 'plannedCopy').length,
    conflict: classified.filter((c) => c.verdict === 'conflict').length,
    copied: classified.filter((c) => c.copied).length,
    verified: classified.filter((c) => c.verdict === 'verified').length,
    perRole: (() => {
      const out: Record<string, Record<string, number>> = {};
      for (const r of ['AVATARS', 'PORTFOLIO', 'INVOICES', 'CLIENT_REQUESTS'] as const) {
        out[r] = {
          total: classified.filter((c) => c.role === r).length,
          sourceMissing: classified.filter((c) => c.role === r && c.verdict === 'sourceMissing').length,
          alreadyPresent: classified.filter((c) => c.role === r && c.verdict === 'alreadyPresent').length,
          plannedCopy: classified.filter((c) => c.role === r && c.verdict === 'plannedCopy').length,
          conflict: classified.filter((c) => c.role === r && c.verdict === 'conflict').length,
          verified: classified.filter((c) => c.role === r && c.verdict === 'verified').length,
        };
      }
      return out;
    })(),
  };

  console.log(
    JSON.stringify(
      {
        summary,
        details: classified.map((c) => ({
          role: c.role,
          key: c.key,
          source: c.source,
          verdict: c.verdict,
          srcSize: c.srcSize,
          dstSize: c.dstSize,
          srcSha1: c.srcSha1,
          dstSha1: c.dstSha1,
          ...(c.copied ? { copied: true } : {}),
          ...(c.error ? { error: c.error } : {}),
        })),
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
  if (summary.sourceMissing > 0 || summary.conflict > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error('[b2-cutover] FAILED', (err as Error).message);
  process.exit(1);
});
