/**
 * One-shot: lists every unfinished large file in the FILE_MANAGER
 * bucket, with age + size + fileId. Lets you see how much B2 mess is
 * currently hanging around from aborted multipart uploads (user
 * reloaded page, network dropped, cancel didn't reach B2, etc).
 *
 * Usage:
 *   npx ts-node scripts/b2-list-unfinished-large-files.ts
 *
 * Needs B2_KEY_ID + B2_APP_KEY and B2_BUCKET_FILE_MANAGER_ID in env
 * (or just the regular prod `.env`).
 */
import B2 from 'backblaze-b2';
import 'dotenv/config';

async function main() {
  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APP_KEY;
  const bucketId = process.env.B2_BUCKET_FILE_MANAGER_ID;

  if (!keyId || !appKey) {
    console.error('Missing B2_KEY_ID / B2_APP_KEY in env');
    process.exit(1);
  }
  if (!bucketId) {
    console.error('Missing B2_BUCKET_FILE_MANAGER_ID in env');
    process.exit(1);
  }

  const b2 = new B2({ applicationKeyId: keyId, applicationKey: appKey });
  await b2.authorize();

  let startFileId: string | undefined;
  let totalCount = 0;
  let totalBytes = 0;

  console.log('fileId'.padEnd(80), 'size(MB)'.padStart(10), 'ageDays'.padStart(10), '  name');
  console.log('-'.repeat(140));

  do {
    const { data } = await b2.listUnfinishedLargeFiles({
      bucketId,
      startFileId,
      maxFileCount: 100,
      // Required by TypeScript signature even though optional in API
      namePrefix: '',
    } as unknown as {
      bucketId: string;
      startFileId?: string;
      maxFileCount: number;
      namePrefix: string;
    });

    for (const f of data.files ?? []) {
      /* Fetch parts to sum size. One extra call per unfinished file —
       * fine for small inventory; skip if too noisy. */
      let fileBytes = 0;
      try {
        const parts = await b2.listParts({
          fileId: f.fileId,
          startPartNumber: 0,
          maxPartCount: 10000,
        } as unknown as { fileId: string; startPartNumber: number; maxPartCount: number });
        fileBytes = (parts.data.parts ?? []).reduce(
          (acc: number, p: { contentLength: number }) => acc + p.contentLength,
          0,
        );
      } catch {
        /* ignore — show 0 if listParts fails */
      }
      const ageDays =
        (Date.now() - Number(f.uploadTimestamp)) / (1000 * 60 * 60 * 24);
      console.log(
        f.fileId.padEnd(80),
        (fileBytes / (1024 * 1024)).toFixed(1).padStart(10),
        ageDays.toFixed(1).padStart(10),
        '  ' + f.fileName,
      );
      totalCount++;
      totalBytes += fileBytes;
    }

    startFileId = data.nextFileId ?? undefined;
  } while (startFileId);

  console.log('-'.repeat(140));
  console.log(
    `TOTAL: ${totalCount} unfinished files, ${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
