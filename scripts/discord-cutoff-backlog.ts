/* eslint-disable no-console */
/**
 * Discord job-post alert backlog cutoff.
 *
 * Operator utility to drain the historical backlog of JOB_POST_MATCH
 * NotificationEvents that have accumulated with no NotificationDelivery
 * row (because `scanner.discordAlertsEnabled` was off, or the operator
 * is about to re-point `DiscordProfile.salesChannelId` at a fresh
 * channel and does not want the historical tail replayed).
 *
 * Steps (dry-run by default; `--apply` to perform):
 *   1. Count JOB_POST_MATCH NotificationEvents with no delivery row.
 *      With --apply: createMany NotificationDelivery(SKIPPED,
 *      error=backlog-cutoff-manual) so orphan recovery never picks
 *      them up again.
 *   2. Count BullMQ job keys for `notification_send` in Redis
 *      (prefix honours the BULLMQ_PREFIX env var, default `bull`).
 *      With --apply: delete those keys so a drain-in-flight cannot
 *      post to Discord.
 *
 * Reads DATABASE_URL + REDIS_HOST/REDIS_PORT from .env (via
 * `dotenv/config`). Idempotent — safe to re-run.
 *
 *   npx ts-node scripts/discord-cutoff-backlog.ts            # dry-run
 *   npx ts-node scripts/discord-cutoff-backlog.ts --apply    # perform
 */
import 'dotenv/config';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationType,
  PrismaClient,
} from '@prisma/client';
import IORedis from 'ioredis';

const BULL_QUEUE_NAME = 'notification_send';

type MinimalDb = Pick<
  PrismaClient,
  'notificationEvent' | 'notificationDelivery'
>;

export interface CutoffPlan {
  mode: 'dry-run' | 'apply';
  db: {
    orphanEventCount: number;
    rowsInserted?: number;
  };
  redis: {
    prefix: string;
    pattern: string;
    matchedKeyCount: number;
    keysDeleted?: number;
  };
}

/**
 * Pure, testable DB half of the cutoff. Does not touch Redis.
 */
export async function cutoffDbBacklog(
  prisma: MinimalDb,
  opts: { apply: boolean },
): Promise<CutoffPlan['db']> {
  const orphans = await prisma.notificationEvent.findMany({
    where: {
      type: NotificationType.JOB_POST_MATCH,
      deliveries: { none: {} },
    },
    select: { id: true },
  });
  if (!orphans.length) return { orphanEventCount: 0 };
  if (!opts.apply) return { orphanEventCount: orphans.length };

  const now = new Date();
  const res = await prisma.notificationDelivery.createMany({
    data: orphans.map(({ id }) => ({
      eventId: id,
      channel: NotificationChannel.DISCORD,
      status: NotificationDeliveryStatus.SKIPPED,
      error: 'backlog-cutoff-manual',
      failedAttempts: 0,
      createdAt: now,
      updatedAt: now,
    })),
    skipDuplicates: true,
  });
  return { orphanEventCount: orphans.length, rowsInserted: res.count };
}

/**
 * Pure, testable Redis half of the cutoff. Uses SCAN to avoid
 * blocking the server (never KEYS).
 */
export async function cutoffBullBacklog(
  redis: Pick<IORedis, 'scanStream' | 'del'>,
  opts: { apply: boolean; prefix: string },
): Promise<CutoffPlan['redis']> {
  const pattern = `${opts.prefix}:${BULL_QUEUE_NAME}:*`;
  const stream = redis.scanStream({ match: pattern, count: 500 });
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: string[]) => {
      for (const k of chunk) keys.push(k);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  if (!keys.length || !opts.apply) {
    return {
      prefix: opts.prefix,
      pattern,
      matchedKeyCount: keys.length,
    };
  }

  // DEL in chunks so one giant argv doesn't blow the client limit.
  let deleted = 0;
  const CHUNK = 500;
  for (let i = 0; i < keys.length; i += CHUNK) {
    deleted += await redis.del(...keys.slice(i, i + CHUNK));
  }
  return {
    prefix: opts.prefix,
    pattern,
    matchedKeyCount: keys.length,
    keysDeleted: deleted,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  const redis = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  });
  try {
    const db = await cutoffDbBacklog(prisma, { apply });
    const prefix = process.env.BULLMQ_PREFIX || 'bull';
    const redisRes = await cutoffBullBacklog(redis, { apply, prefix });

    const plan: CutoffPlan = {
      mode: apply ? 'apply' : 'dry-run',
      db,
      redis: redisRes,
    };
    const hint = apply ? undefined : 'Re-run with --apply to perform.';
    console.log(
      JSON.stringify({ ...plan, ...(hint ? { hint } : {}) }, null, 2),
    );
  } catch (err) {
    console.error(
      '[discord-cutoff-backlog] failed:',
      (err as Error).message,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

if (require.main === module) {
  void main();
}
