import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { DiscordBotClient } from '../discord-integration/discord-bot.client';

/**
 * Fire-and-forget Discord notifier for credential-vault mutations.
 * Reuses the active DiscordProfile's `pmsChannelId` (same channel the
 * late-report "please fill" reminders go to) so the owner's existing
 * notification subscription covers this feed too.
 *
 * Scope on purpose:
 *   • delivery is direct (no queue, no retry, no DiscordDelivery row);
 *   • Discord outage ⇒ one log line, mutation still succeeds;
 *   • if reliability becomes critical, promote to the queue pattern
 *     seen in `DiscordLateReportService`.
 */
@Injectable()
export class CredentialChangeNotifierService {
  private readonly logger = new Logger(CredentialChangeNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: DiscordBotClient,
  ) {}

  async notify(payload: {
    kind: 'account_updated' | 'account_restored' | 'account_hard_deleted' | 'profile_hard_deleted';
    profileName: string;
    serviceName?: string;
    changedFields?: string[];
    actorUserId: string;
  }): Promise<void> {
    try {
      const [profile, actor] = await Promise.all([
        this.prisma.discordProfile.findFirst({
          where: { active: true },
          select: { pmsChannelId: true },
        }),
        this.prisma.user.findUnique({
          where: { id: payload.actorUserId },
          select: { email: true, firstName: true, lastName: true },
        }),
      ]);
      if (!profile?.pmsChannelId) {
        this.logger.debug('No active Discord profile / pmsChannelId; skip');
        return;
      }
      const actorLabel = actor?.email ?? payload.actorUserId;
      const content = this.formatMessage({ ...payload, actorLabel });
      const res = await this.bot.postMessage({
        channelId: profile.pmsChannelId,
        content,
        allowedMentions: { parse: [] },
      });
      if (!res.ok) {
        this.logger.warn(
          `credential-change notif failed: ${res.message.slice(0, 200)}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `credential-change notif crashed: ${String((err as Error).message ?? err)}`,
      );
    }
  }

  /**
   * Short one-line Discord message. Secret VALUES are never included —
   * only field KEYS so a reader can tell what changed without having
   * to open the vault.
   */
  private formatMessage(p: {
    kind: string;
    profileName: string;
    serviceName?: string;
    changedFields?: string[];
    actorLabel: string;
  }): string {
    const actor = p.actorLabel;
    const svc = p.serviceName ? ` / ${p.serviceName}` : '';
    switch (p.kind) {
      case 'account_updated': {
        const fields =
          p.changedFields && p.changedFields.length > 0
            ? p.changedFields.join(', ')
            : '(no fields changed)';
        return `:lock: **Credential updated** — ${p.profileName}${svc} · fields: \`${fields}\` · by ${actor}`;
      }
      case 'account_restored': {
        return `:leftwards_arrow_with_hook: **Credential restored** — ${p.profileName}${svc} · by ${actor}`;
      }
      case 'account_hard_deleted': {
        return `:warning: **Credential account deleted** — ${p.profileName}${svc} · by ${actor}`;
      }
      case 'profile_hard_deleted': {
        return `:warning: **Credential profile deleted** — ${p.profileName} · by ${actor}`;
      }
      default:
        return `credential event · ${p.kind} · ${p.profileName}${svc} · by ${actor}`;
    }
  }
}
