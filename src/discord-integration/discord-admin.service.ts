import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type DiscordProfile, DiscordProfileName } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { DiscordBotClient } from './discord-bot.client';
import { DiscordEmbedBuilderService } from './discord-embed-builder.service';
import { logicalReportDate, localCalendarDate } from './logical-date';

export type VerifyChannelKey =
  | 'pmsChannelId'
  | 'generalChannelId'
  | 'salesChannelId'
  | 'opsChannelId';

export interface VerifyResult {
  profileName: DiscordProfileName;
  guild: { configured: boolean; ok: boolean; name?: string; error?: string };
  channels: Record<
    VerifyChannelKey,
    { configured: boolean; ok: boolean; name?: string; error?: string }
  >;
  role: { configured: boolean; ok: boolean; name?: string; error?: string };
  botInGuild: { ok: boolean; roleCount?: number; error?: string };
  checkedAt: string;
}

export type PreviewJob =
  | 'REPORT'
  | 'LATE_REPORT'
  | 'BIRTHDAY'
  | 'ABSENCES'
  | 'REMINDER_18'
  | 'DAILY_DIGEST_19'
  | 'WEEKLY_DIGEST';

/**
 * Admin-only Discord operations: verify access (no writes) + send
 * test (small ping) + send preview (synthetic examples).
 *
 * Preview messages carry a `[PREVIEW]` prefix and never consume a
 * production idempotency key — they bypass `DiscordDelivery`
 * entirely, so a preview run cannot squash the real digest's
 * `deliveryKey`.
 */
@Injectable()
export class DiscordAdminService {
  private readonly logger = new Logger(DiscordAdminService.name);
  private readonly VERIFY_CHANNEL_KEYS: VerifyChannelKey[] = [
    'pmsChannelId',
    'generalChannelId',
    'salesChannelId',
    'opsChannelId',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: DiscordBotClient,
    private readonly embeds: DiscordEmbedBuilderService,
  ) {}

  async verify(name: DiscordProfileName): Promise<VerifyResult> {
    const profile = await this.require(name);
    const result: VerifyResult = {
      profileName: name,
      guild: { configured: !!profile.guildId, ok: false },
      channels: {
        pmsChannelId: { configured: !!profile.pmsChannelId, ok: false },
        generalChannelId: { configured: !!profile.generalChannelId, ok: false },
        salesChannelId: { configured: !!profile.salesChannelId, ok: false },
        opsChannelId: { configured: !!profile.opsChannelId, ok: false },
      },
      role: { configured: !!profile.managerRoleId, ok: false },
      botInGuild: { ok: false },
      checkedAt: new Date().toISOString(),
    };

    if (profile.guildId) {
      const g = await this.bot.getGuild(profile.guildId);
      if (g.ok) {
        result.guild.ok = true;
        result.guild.name = g.name;
        const self = await this.bot.getSelfMember(profile.guildId);
        if (self.ok) {
          result.botInGuild.ok = true;
          result.botInGuild.roleCount = self.roleIds.length;
        } else {
          result.botInGuild.error = this.explain(self.status, self.message);
        }
      } else {
        result.guild.error = this.explain(g.status, g.message);
      }
    }

    for (const key of this.VERIFY_CHANNEL_KEYS) {
      const id = profile[key] as string | null;
      if (!id) continue;
      const r = await this.bot.getChannel(id);
      if (r.ok) {
        result.channels[key].ok = true;
        result.channels[key].name = r.name;
        if (profile.guildId && r.guildId && r.guildId !== profile.guildId) {
          result.channels[key].ok = false;
          result.channels[key].error = `channel is in guild ${r.guildId}, not ${profile.guildId}`;
        }
      } else {
        result.channels[key].error = this.explain(r.status, r.message);
      }
    }

    if (profile.guildId && profile.managerRoleId) {
      const roles = await this.bot.getGuildRoles(profile.guildId);
      if (roles.ok) {
        const match = roles.roles.find((r) => r.id === profile.managerRoleId);
        if (match) {
          result.role.ok = true;
          result.role.name = match.name;
        } else {
          result.role.error = `role ${profile.managerRoleId} not found in guild`;
        }
      } else {
        result.role.error = this.explain(roles.status, roles.message);
      }
    }

    // Record the verify timestamp (store last error compactly).
    const errorBits: string[] = [];
    if (result.guild.configured && !result.guild.ok)
      errorBits.push(`guild: ${result.guild.error}`);
    for (const key of this.VERIFY_CHANNEL_KEYS) {
      const c = result.channels[key];
      if (c.configured && !c.ok) errorBits.push(`${key}: ${c.error}`);
    }
    if (result.role.configured && !result.role.ok)
      errorBits.push(`role: ${result.role.error}`);
    await this.prisma.discordProfile.update({
      where: { id: profile.id },
      data: {
        lastVerifiedAt: new Date(),
        lastVerificationError: errorBits.length ? errorBits.join('; ').slice(0, 500) : null,
      },
    });

    return result;
  }

  async sendTest(name: DiscordProfileName): Promise<{ ok: true; messageId: string }> {
    const profile = await this.require(name);
    if (!profile.pmsChannelId) {
      throw new BadRequestException('pmsChannelId is required to send a test');
    }
    const resp = await this.bot.postMessage({
      channelId: profile.pmsChannelId,
      content: `[TEST] Discord integration is wired up — profile \`${profile.name}\` at ${new Date().toISOString()}`,
    });
    if (!resp.ok) {
      throw new BadRequestException(this.explain(resp.status, resp.message));
    }
    return { ok: true, messageId: resp.messageId };
  }

  async sendPreview(
    name: DiscordProfileName,
    job: PreviewJob,
  ): Promise<{ ok: true; messageId: string; channel: VerifyChannelKey }> {
    const profile = await this.require(name);
    const target = this.previewTarget(profile, job);
    if (!target.channelId) {
      throw new BadRequestException(
        `${target.channel} is required to preview this job`,
      );
    }
    const payload = this.buildPreview(profile, job);
    const resp = await this.bot.postMessage({
      channelId: target.channelId,
      content: `[PREVIEW] ${payload.content ?? ''}`.trim(),
      embeds: payload.embeds,
      allowedMentions: { parse: [] }, // never ping anyone from a preview
    });
    if (!resp.ok) {
      throw new BadRequestException(this.explain(resp.status, resp.message));
    }
    return { ok: true, messageId: resp.messageId, channel: target.channel };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  private previewTarget(
    profile: DiscordProfile,
    job: PreviewJob,
  ): { channel: VerifyChannelKey; channelId: string | null } {
    switch (job) {
      case 'BIRTHDAY':
        return { channel: 'generalChannelId', channelId: profile.generalChannelId };
      case 'ABSENCES':
      case 'REMINDER_18':
      case 'DAILY_DIGEST_19':
      case 'WEEKLY_DIGEST':
      case 'LATE_REPORT':
      case 'REPORT':
        return { channel: 'pmsChannelId', channelId: profile.pmsChannelId };
    }
  }

  private buildPreview(
    profile: DiscordProfile,
    job: PreviewJob,
  ): { content?: string; embeds?: Array<Record<string, unknown>> } {
    const today = localCalendarDate(new Date(), profile.timezone);
    switch (job) {
      case 'REPORT':
        return {
          embeds: [
            this.embeds.reportEmbed({
              projectName: 'Example Project',
              hours: 6,
              reportDate: today,
              text: 'Finished the invoicing module and reviewed two PRs.',
              isLate: false,
            }),
          ],
        };
      case 'LATE_REPORT':
        return {
          embeds: [
            this.embeds.lateReportEmbed({
              projectName: 'Example Project',
              hours: 3,
              reportDate: logicalReportDate({
                now: new Date(),
                cutoffHour: profile.cutoffHour,
                timezone: profile.timezone,
              }),
              text: 'Filed yesterday’s work this morning.',
              submittedAt: new Date(),
            }),
          ],
        };
      case 'BIRTHDAY':
        return {
          content: this.embeds.birthdayContent(['Alice Example', 'Bob Example']),
        };
      case 'ABSENCES':
        return {
          content: 'Who is off today',
          embeds: this.embeds.absencesEmbeds([
            {
              type: 'VACATION',
              firstName: 'Alice',
              lastName: 'Example',
              endDate: new Date(today.getTime() + 86400000 * 3),
            },
            {
              type: 'SICK_LEAVE',
              firstName: 'Bob',
              lastName: 'Example',
              endDate: new Date(today.getTime() + 86400000),
            },
          ]),
        };
      case 'REMINDER_18':
        return { content: this.embeds.reminderContent(profile.managerRoleId) };
      case 'DAILY_DIGEST_19':
        return {
          content: `Daily reports — ${today.toISOString().slice(0, 10)}`,
          embeds: this.embeds.dailyDigestEmbeds({
            reportDate: today,
            rows: [
            ],
          }),
        };
      case 'WEEKLY_DIGEST':
        return {
          content: 'Weekly reports — preview',
          embeds: this.embeds.weeklyDigestEmbeds([
            { projectName: 'Example Project A', hours: 38 },
            { projectName: 'Example Project B', hours: 22 },
          ]),
        };
    }
  }

  private async require(name: DiscordProfileName): Promise<DiscordProfile> {
    const row = await this.prisma.discordProfile.findUnique({ where: { name } });
    if (!row) throw new NotFoundException(`Profile ${name} not found`);
    return row;
  }

  private explain(status: number, message: string): string {
    if (status === 0) return message;
    if (status === 401 || status === 403) return `bot auth/permission (${status}): ${message}`;
    if (status === 404) return `not found (${status}): ${message}`;
    if (status === 429) return `rate limited (${status}): ${message}`;
    return `${status}: ${message}`;
  }
}
