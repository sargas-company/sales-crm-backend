import 'dotenv/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import B2 = require('backblaze-b2');

const execAsync = promisify(exec);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parsed.port || '5432';
  const database = parsed.pathname.replace(/^\//, '');
  const user = parsed.username;
  const password = decodeURIComponent(parsed.password);

  const bin = process.env.PG_DUMP_BIN || 'pg_dump';
  const cmd = `${bin} -h ${host} -p ${port} -U ${user} -Fc ${database}`;

  console.log('Creating database dump...');
  const { stdout } = await execAsync(cmd, {
    env: { ...process.env, PGPASSWORD: password },
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });

  const buffer = stdout as unknown as Buffer;
  console.log(`Dump size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const fileName = `manual/${dd}-${mm}-${yyyy}_${hh}${min}.dump`;

  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APP_KEY;
  const bucketId = process.env.B2_BUCKET_DB_DUMPS_ID;

  if (!keyId || !appKey || !bucketId) {
    throw new Error('B2_KEY_ID, B2_APP_KEY or B2_BUCKET_DB_DUMPS_ID is not set');
  }

  console.log(`Uploading to B2: ${fileName}...`);

  const b2 = new B2({ applicationKeyId: keyId, applicationKey: appKey });
  await b2.authorize();

  const { data: uploadUrlData } = await b2.getUploadUrl({ bucketId });

  await b2.uploadFile({
    uploadUrl: uploadUrlData.uploadUrl,
    uploadAuthToken: uploadUrlData.authorizationToken,
    fileName,
    data: buffer,
    mime: 'application/octet-stream',
    contentLength: buffer.length,
  });

  console.log(`Backup uploaded: ${fileName}`);
}

main().catch((err: Error) => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
