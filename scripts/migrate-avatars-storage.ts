/* eslint-disable no-console */
/**
 * Avatar storage migration utility.
 *
 * Copies existing `avatars/*` objects from the legacy
 * `CLIENT_REQUESTS` bucket into the new dedicated `AVATARS` bucket.
 * Keys are preserved so `User.avatarKey` remains valid without a DB
 * update. Preset avatars (`avatarKey = "preset:*"`) are skipped —
 * they live on DiceBear.
 *
 * Idempotent. Dry-run by default — pass `--apply` to actually copy.
 *
 *   npx ts-node scripts/migrate-avatars-storage.ts            # dry-run
 *   npx ts-node scripts/migrate-avatars-storage.ts --apply    # perform
 *
 * The script never deletes from the source bucket.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import B2 = require('backblaze-b2');

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APP_KEY;
  const srcBucketId = process.env.B2_BUCKET_CLIENT_REQUESTS_ID;
  const dstBucketId = process.env.B2_BUCKET_AVATARS_ID;
  if (!keyId || !appKey || !srcBucketId || !dstBucketId) {
    throw new Error(
      'Missing env: B2_KEY_ID / B2_APP_KEY / B2_BUCKET_CLIENT_REQUESTS_ID / B2_BUCKET_AVATARS_ID',
    );
  }

  const b2 = new B2({ applicationKeyId: keyId, applicationKey: appKey });
  await b2.authorize();

  const users = await prisma.user.findMany({
    where: { avatarKey: { not: null } },
    select: { id: true, avatarKey: true },
  });

  let considered = 0;
  let copied = 0;
  let presetSkipped = 0;
  let missingSrc = 0;
  let alreadyAtDst = 0;

  for (const u of users) {
    const key = u.avatarKey!;
    if (key.startsWith('preset:')) {
      presetSkipped++;
      continue;
    }
    considered++;

    const atDst = await b2
      .listFileNames({
        bucketId: dstBucketId,
        startFileName: key,
        maxFileCount: 1,
        delimiter: '',
        prefix: key,
      })
      .then((r) => r.data.files.some((f) => f.fileName === key))
      .catch(() => false);
    if (atDst) {
      alreadyAtDst++;
      continue;
    }

    const atSrc = await b2
      .listFileNames({
        bucketId: srcBucketId,
        startFileName: key,
        maxFileCount: 1,
        delimiter: '',
        prefix: key,
      })
      .then((r) => r.data.files.find((f) => f.fileName === key))
      .catch(() => undefined);
    if (!atSrc) {
      missingSrc++;
      continue;
    }

    if (!apply) continue;

    const dl = await b2.downloadFileById({
      fileId: atSrc.fileId,
      responseType: 'arraybuffer',
    });
    const buf = Buffer.from(dl.data as ArrayBuffer);
    const { data: upUrl } = await b2.getUploadUrl({ bucketId: dstBucketId });
    await b2.uploadFile({
      uploadUrl: upUrl.uploadUrl,
      uploadAuthToken: upUrl.authorizationToken,
      fileName: key,
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
        mode: apply ? 'apply' : 'dry-run',
        totalUsersWithAvatar: users.length,
        presetSkipped,
        candidateUploadedAvatars: considered,
        alreadyAtDst,
        missingSrc,
        copied,
        plannedCopy: apply ? 0 : considered - alreadyAtDst - missingSrc,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[avatars-migrate] FAILED', err);
  process.exit(1);
});
