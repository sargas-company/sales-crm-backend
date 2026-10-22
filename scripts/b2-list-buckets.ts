/* eslint-disable no-console */
/**
 * One-shot helper: lists every B2 bucket your current application key
 * can see, prints `<name> → <id>` for each. Used once to grab the
 * bucket ID when B2's web UI hides it.
 *
 * Reads credentials from the usual B2 env vars (same the backup runner
 * and StorageService use). Run from the backend root:
 *
 *   npx tsx scripts/b2-list-buckets.ts
 */
import 'dotenv/config';
import B2 = require('backblaze-b2');

async function main() {
  const keyId = process.env.B2_KEY_ID ?? process.env.B2_APPLICATION_KEY_ID;
  const appKey = process.env.B2_APP_KEY ?? process.env.B2_APPLICATION_KEY;
  if (!keyId || !appKey) {
    console.error(
      'Missing B2 creds. Expected env vars B2_KEY_ID + B2_APP_KEY (or B2_APPLICATION_KEY_ID + B2_APPLICATION_KEY).',
    );
    process.exit(1);
  }

  const b2 = new B2({ applicationKeyId: keyId, applicationKey: appKey });
  const auth = await b2.authorize();
  const accountId = (auth.data as { accountId?: string }).accountId;
  if (!accountId) {
    console.error('authorize() returned no accountId — key may be scoped.');
    process.exit(1);
  }

  const { data } = await b2.listBuckets({ accountId });
  const rows = (data as { buckets?: Array<{ bucketName: string; bucketId: string; bucketType: string }> }).buckets ?? [];
  if (rows.length === 0) {
    console.log('No buckets visible to this key.');
    return;
  }
  console.log(`Found ${rows.length} bucket(s):`);
  for (const b of rows) {
    console.log(`  ${b.bucketName.padEnd(40)}  ${b.bucketId}  [${b.bucketType}]`);
  }
}

main().catch((err) => {
  console.error('Failed:', (err as Error).message);
  process.exit(1);
});
