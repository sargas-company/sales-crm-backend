/**
 * Jest setupFiles hook — runs ONCE per worker before any import
 * creates a PrismaClient or opens a Redis connection.
 *
 * Responsibilities:
 *   1. Require `TEST_DATABASE_URL` and override `DATABASE_URL` from
 *      it so every `new PrismaClient()` in specs talks to the test
 *      DB, not the application DB.
 *   2. Hard-refuse to run when the resolved DATABASE_URL points at
 *      the app DB (`ai_dashboard` without a `_test` suffix) OR at
 *      anything that is not a local Postgres (host must be
 *      `localhost` / `127.0.0.1` / `::1`).
 *   3. Set a shared BullMQ key prefix via `BULLMQ_PREFIX` so any
 *      Queue construction in tests lands in the test namespace.
 *   4. Set `APP_ENV=test` so other guards can detect test runs.
 *
 * The checks run on every `npx jest` invocation — direct, through
 * npm scripts, or via `jest --watch` — because they live in a
 * `setupFiles` hook that Jest always honours.
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error(
    '[test-isolation] TEST_DATABASE_URL is required to run jest. ' +
      'Expected a local Postgres URL whose database name ends with "_test". ' +
      'This stops specs from writing to the application DB.',
  );
}

const parsed = (() => {
  try {
    return new URL(TEST_DB_URL);
  } catch {
    throw new Error('[test-isolation] TEST_DATABASE_URL is not a parseable URL');
  }
})();

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
if (!LOCAL_HOSTS.has(parsed.hostname)) {
  throw new Error(
    `[test-isolation] TEST_DATABASE_URL host must be local (got "${parsed.hostname}")`,
  );
}

// The DB name is the path segment after `/`, before `?`.
const dbName = parsed.pathname.replace(/^\//, '');
if (!/_test$/.test(dbName)) {
  throw new Error(
    `[test-isolation] test DB name "${dbName}" must end with "_test" ` +
      '— refuse to run tests against the application DB.',
  );
}

process.env.DATABASE_URL = TEST_DB_URL;
process.env.APP_ENV = 'test';
if (!process.env.BULLMQ_PREFIX) {
  process.env.BULLMQ_PREFIX = `bull-test-${process.pid}`;
}

// Final sanity check: whatever downstream code reads is the test URL.
if (process.env.DATABASE_URL !== TEST_DB_URL) {
  throw new Error('[test-isolation] DATABASE_URL override failed');
}
