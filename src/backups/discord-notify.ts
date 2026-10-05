/* eslint-disable no-console */
import axios from 'axios';
import { BackupType } from '@prisma/client';

/**
 * Resolve the Discord webhook URL to use for ops notifications.
 * `DISCORD_OPS_WEBHOOK_URL` is preferred; `DISCORD_WEBHOOK_URL` is
 * accepted as a legacy fallback so existing environments keep
 * working. Returns null when neither is set — callers must treat
 * that as "notifications disabled" and continue silently.
 */
export function resolveOpsWebhook(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.DISCORD_OPS_WEBHOOK_URL ?? env.DISCORD_WEBHOOK_URL ?? '';
  return url.trim() || null;
}

/**
 * Backups success notifications are deliberately quiet for `DAILY`
 * runs to avoid daily webhook noise. Every failure, and every
 * success for human-triggered or deploy-coupled runs, is sent.
 */
export function shouldNotifySuccess(type: BackupType): boolean {
  return type !== BackupType.DAILY;
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
