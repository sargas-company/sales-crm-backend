import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type DiscordProfile,
  DiscordProfileName,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { isDiscordSnowflake } from './ed25519';

export type DiscordProfileView = Omit<DiscordProfile, 'lastFailureMessage' | 'lastVerificationError'> & {
  configured: boolean;
  // Secret-free presence flags, same as what the Credentials page
  // uses for its vault keys.
  envStatus: {
    appIdSet: boolean;
    publicKeySet: boolean;
    botTokenSet: boolean;
  };
  lastFailureMessage: string | null;
  lastVerificationError: string | null;
};

export interface UpdateProfileDto {
  guildId?: string | null;
  pmsChannelId?: string | null;
  generalChannelId?: string | null;
  salesChannelId?: string | null;
  opsChannelId?: string | null;
  managerRoleId?: string | null;
  reportsEnabled?: boolean;
  birthdaysEnabled?: boolean;
  absencesEnabled?: boolean;
  weeklyEnabled?: boolean;
  cutoffHour?: number;
  reminderAt?: string;
  dailyDigestAt?: string;
  weeklyDigestDay?: number;
  weeklyDigestAt?: string;
  birthdayAt?: string;
  absencesAt?: string;
  timezone?: string;
}

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

@Injectable()
export class DiscordProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async listAll(): Promise<DiscordProfileView[]> {
    const rows = await this.prisma.discordProfile.findMany({
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.decorate(r));
  }

  async getByName(name: DiscordProfileName): Promise<DiscordProfileView> {
    const row = await this.prisma.discordProfile.findUnique({ where: { name } });
    if (!row) throw new NotFoundException(`Profile ${name} not found`);
    return this.decorate(row);
  }

  async update(name: DiscordProfileName, dto: UpdateProfileDto): Promise<DiscordProfileView> {
    this.validate(dto);
    const row = await this.prisma.discordProfile.update({
      where: { name },
      data: dto,
    });
    return this.decorate(row);
  }

  async activate(name: DiscordProfileName): Promise<DiscordProfileView> {
    const target = await this.prisma.discordProfile.findUnique({ where: { name } });
    if (!target) throw new NotFoundException(`Profile ${name} not found`);
    if (!this.isConfigured(target)) {
      throw new BadRequestException(
        `Profile ${name} is incomplete; set guild, PMS and General channel IDs and a manager role id before activating.`,
      );
    }
    // Atomic swap: deactivate everyone, then activate the chosen row.
    await this.prisma.$transaction([
      this.prisma.discordProfile.updateMany({ data: { active: false } }),
      this.prisma.discordProfile.update({
        where: { id: target.id },
        data: { active: true },
      }),
    ]);
    const updated = await this.prisma.discordProfile.findUnique({
      where: { id: target.id },
    });
    return this.decorate(updated!);
  }

  async getActive(): Promise<DiscordProfile | null> {
    return this.prisma.discordProfile.findFirst({ where: { active: true } });
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private validate(dto: UpdateProfileDto) {
    const snowflakeFields: Array<[keyof UpdateProfileDto, string]> = [
      ['guildId', 'guildId'],
      ['pmsChannelId', 'pmsChannelId'],
      ['generalChannelId', 'generalChannelId'],
      ['salesChannelId', 'salesChannelId'],
      ['opsChannelId', 'opsChannelId'],
      ['managerRoleId', 'managerRoleId'],
    ];
    for (const [field, label] of snowflakeFields) {
      const v = dto[field];
      if (v !== undefined && v !== null && !isDiscordSnowflake(v)) {
        throw new BadRequestException(`${label} must be a Discord snowflake id`);
      }
    }
    const timeFields: Array<[keyof UpdateProfileDto, string]> = [
      ['reminderAt', 'reminderAt'],
      ['dailyDigestAt', 'dailyDigestAt'],
      ['weeklyDigestAt', 'weeklyDigestAt'],
      ['birthdayAt', 'birthdayAt'],
      ['absencesAt', 'absencesAt'],
    ];
    for (const [field, label] of timeFields) {
      const v = dto[field];
      if (v !== undefined && typeof v === 'string' && !TIME_HHMM.test(v)) {
        throw new BadRequestException(`${label} must be HH:MM in 24h form`);
      }
    }
    if (
      dto.cutoffHour !== undefined &&
      (!Number.isInteger(dto.cutoffHour) || dto.cutoffHour < 0 || dto.cutoffHour > 23)
    ) {
      throw new BadRequestException('cutoffHour must be an integer 0..23');
    }
    if (
      dto.weeklyDigestDay !== undefined &&
      (!Number.isInteger(dto.weeklyDigestDay) ||
        dto.weeklyDigestDay < 0 ||
        dto.weeklyDigestDay > 6)
    ) {
      throw new BadRequestException('weeklyDigestDay must be 0..6 (0=Sun)');
    }
    if (dto.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: dto.timezone });
      } catch {
        throw new BadRequestException('timezone is not a valid IANA zone');
      }
    }
  }

  private isConfigured(r: DiscordProfile): boolean {
    return (
      !!r.guildId &&
      !!r.pmsChannelId &&
      !!r.generalChannelId &&
      !!r.managerRoleId
    );
  }

  private decorate(r: DiscordProfile): DiscordProfileView {
    return {
      ...r,
      configured: this.isConfigured(r),
      envStatus: {
        appIdSet: Boolean(process.env.DISCORD_APP_ID),
        publicKeySet: Boolean(process.env.DISCORD_PUBLIC_KEY),
        botTokenSet: Boolean(process.env.DISCORD_BOT_TOKEN),
      },
    };
  }
}
