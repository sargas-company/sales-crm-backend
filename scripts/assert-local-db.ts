import 'dotenv/config';

// Extending any of these constants is a one-line change.
const HOST_ALLOWLIST = ['localhost', '127.0.0.1', '::1'];
const EXPECTED_PORT = '5433';
const DB_NAME_ALLOWLIST = ['ai_dashboard'];

function fail(check: string, detail: string): never {
  console.error(`assert-local-db: ${check} check failed — ${detail}`);
  process.exit(1);
}

function main(): void {
  const appEnv = process.env.APP_ENV;
  if (!appEnv) {
    fail('APP_ENV', 'APP_ENV is not set (expected "local")');
  }
  if (appEnv !== 'local') {
    fail('APP_ENV', `APP_ENV="${appEnv}", expected "local"`);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    fail('DATABASE_URL', 'DATABASE_URL is not set');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail('DATABASE_URL', 'DATABASE_URL is not a parseable URL');
  }

  if (!parsed.protocol.startsWith('postgres')) {
    const proto = parsed.protocol.replace(/:$/, '');
    fail('protocol', `protocol="${proto}", expected postgres/postgresql`);
  }

  const host = parsed.hostname;
  const port = parsed.port;
  const database = parsed.pathname.replace(/^\//, '');

  if (!HOST_ALLOWLIST.includes(host)) {
    fail(
      'host',
      `host="${host}" not in allow-list [${HOST_ALLOWLIST.join(', ')}] ` +
        `(port="${port || '(missing)'}", database="${database || '(missing)'}")`,
    );
  }

  if (port !== EXPECTED_PORT) {
    fail(
      'port',
      `port="${port || '(missing)'}" is not ${EXPECTED_PORT} ` +
        `(host="${host}", database="${database || '(missing)'}")`,
    );
  }

  if (!DB_NAME_ALLOWLIST.includes(database)) {
    fail(
      'database',
      `database="${database || '(missing)'}" not in allow-list ` +
        `[${DB_NAME_ALLOWLIST.join(', ')}] (host="${host}", port="${port}")`,
    );
  }

  console.log(`OK ${database}@${host}:${port}`);
}

main();
