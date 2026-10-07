/**
 * Backup / infrastructure Discord notifications — isolation regression.
 *
 * Covers:
 *   - resolveOpsWebhook() reads ONLY DISCORD_OPS_WEBHOOK_URL. The
 *     legacy DISCORD_WEBHOOK_URL has been removed from runtime use;
 *     backup scripts must not accidentally pick it up.
 *   - A blank / unset DISCORD_OPS_WEBHOOK_URL returns null so callers
 *     treat it as "notifications disabled".
 *
 * These are pure env-shape tests — no network calls.
 */
import { describe, expect, it } from '@jest/globals';

import { resolveOpsWebhook } from './discord-notify';

describe('backups/discord-notify.resolveOpsWebhook', () => {
  it('returns the URL when DISCORD_OPS_WEBHOOK_URL is set', () => {
    const url = resolveOpsWebhook({
      DISCORD_OPS_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x',
    } as unknown as NodeJS.ProcessEnv);
    expect(url).toBe('https://discord.com/api/webhooks/1/x');
  });

  it('returns null when DISCORD_OPS_WEBHOOK_URL is empty', () => {
    expect(
      resolveOpsWebhook({
        DISCORD_OPS_WEBHOOK_URL: '',
      } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('returns null when DISCORD_OPS_WEBHOOK_URL is unset', () => {
    expect(resolveOpsWebhook({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it('does NOT fall back to the removed DISCORD_WEBHOOK_URL — even if the env still has it', () => {
    // Simulates a lingering legacy env var: backup scripts must ignore
    // it so runtime CRM traffic and infra alerts cannot share a target
    // by accident.
    const env = {
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/legacy/y',
    } as unknown as NodeJS.ProcessEnv;
    expect(resolveOpsWebhook(env)).toBeNull();
  });
});
