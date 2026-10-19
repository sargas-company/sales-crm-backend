/* eslint-disable no-console */
import axios from 'axios';
import { BackupType } from '@prisma/client';

/**
 * Resolve the Discord webhook URL used for backup/infrastructure
 * alerts. Only `DISCORD_OPS_WEBHOOK_URL` is accepted — the backup
 * scripts run outside the Nest process and deliberately bypass the
 * active DiscordProfile + bot path so they still fire when the
 * backend is down. Returns null when the var is not set, which
 * callers treat as "notifications disabled" and continue silently.
 */
export function resolveOpsWebhook(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.DISCORD_OPS_WEBHOOK_URL ?? '';
  return url.trim() || null;
}

/**
 * Every backup outcome — success or failure, cron or manual — is
 * announced on the OPS webhook. The DAILY-success-silent carve-out
 * was removed on 2026-10-19 together with the manual-trigger button:
 * the operator wants a positive "backup landed" ping on every run,
 * including the nightly cron, so a missing message means the cron
 * never fired rather than "nothing to say". Kept as a function (not
 * inlined `true`) so a future per-type carve-out stays a one-liner.
 */
export function shouldNotifySuccess(_type: BackupType): boolean {
  return true;
}

export interface NotifyArgs {
  outcome: 'success' | 'failure';
  type: BackupType;
  environment: string;
  message: string;
  webhook?: string | null;
}

/**
 * Fire a Discord message. Never throws; a failed webhook post is
 * logged to stderr and ignored. We also never embed secrets — the
 * message string is treated as pre-sanitised by the caller.
 */
export async function notifyDiscord(args: NotifyArgs): Promise<void> {
  if (args.outcome === 'success' && !shouldNotifySuccess(args.type)) return;
  const url = args.webhook ?? resolveOpsWebhook();
  if (!url) return;
  const prefix = args.outcome === 'success' ? '**Backup OK**' : '**Backup failed**';
  const body = `${prefix} • ${args.type} • \`${args.environment}\`\n\`\`\`\n${args.message.slice(0, 1500)}\n\`\`\``;
  try {
    await axios.post(url, { content: body }, { timeout: 7000 });
  } catch (err) {
    console.error('[discord-notify] webhook failed:', (err as Error).message);
  }
}
