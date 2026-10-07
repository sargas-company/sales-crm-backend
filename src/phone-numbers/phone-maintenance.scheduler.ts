import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AuditResult, AuditSeverity } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import { PhoneMaintenanceService } from './phone-maintenance.service';
import { maskPhone } from './phone-utils';
import {
  getLocalDateMidnightUtc,
  getLocalParts,
  safeTimezone,
} from '../common/time/timezone';
import { DiscordBotClient } from '../discord-integration/discord-bot.client';

/**
 * Daily maintenance tick:
 *   • ensureTasks() creates maintenance rows for phones that have hit
 *     their nextMaintenanceAt and flips DUE → OVERDUE for anything
 *     past its due date;
 *   • sends ONE consolidated Discord reminder listing every open
 *     task, exactly once per calendar day (PhoneReminderLog unique
 *     constraint provides the idempotency).
 *
 * Delivery goes through the active DiscordProfile.opsChannelId via
 * DiscordBotClient. The profile is resolved on every send so a TEST ↔
 * PRODUCTION swap in Settings takes effect without a backend restart.
 */
@Injectable()
export class PhoneMaintenanceScheduler {
  private readonly logger = new Logger(PhoneMaintenanceScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenance: PhoneMaintenanceService,
    private readonly settings: SettingsService,
    private readonly audit: AuditEventService,
    private readonly config: ConfigService,
    private readonly bot: DiscordBotClient,
  ) {}

  /** Fires every minute; cheap, lets the operator pin an exact
   *  hour:minute for the daily reminder. ensureTasks runs on the top
   *  of every hour (local) only (DUE→OVERDUE accuracy); the Discord
   *  reminder fires exactly when the local hour+minute match the
   *  configured values in the workspace timezone (`general.timezone`,
   *  default Europe/Kyiv, invalid values fall back to the default). */
  @Cron('0 * * * * *', { name: 'phone-maintenance-tick' })
  async tick() {
    try {
      const now = new Date();
      const tz = await this.resolveTimezone();
      const localNow = getLocalParts(now, tz);
      if (localNow.minute === 0) {
        await this.maintenance.ensureTasks(now);
      }
      const configuredHour = await this.settings.getNumberForKey(
        SK.PHONE_ALERTS_SEND_HOUR,
        9,
      );
      const configuredMinute = await this.settings.getNumberForKey(
        SK.PHONE_ALERTS_SEND_MINUTE,
        0,
      );
      if (
        localNow.hour !== configuredHour ||
        localNow.minute !== configuredMinute
      )
        return;
      await this.sendDailyReminder(now, tz);
    } catch (err) {
      this.logger.error(
        `tick failed: ${(err as Error).message}`,
      );
    }
  }

  /** Resolve the workspace business timezone, honoring the operator
   *  setting and silently falling back when the value is missing or
   *  invalid. */
  async resolveTimezone(): Promise<string> {
    const raw = await this.settings.getStringForKey(
      SK.GENERAL_TIMEZONE,
      'Europe/Kyiv',
    );
    return safeTimezone(raw);
  }

  /**
   * Resolve filter preferences from settings. The webhook URL is NOT
   * read any more — delivery goes through the active DiscordProfile
   * via the bot. Kept as its own method so `sendTestPing` and the
   * scheduler share the same enablement check.
   */
  async resolveConfig() {
    const enabled = await this.settings.getBooleanForKey(
      SK.PHONE_ALERTS_ENABLED,
      false,
    );
    const includeDue = await this.settings.getBooleanForKey(
      SK.PHONE_ALERTS_INCLUDE_DUE,
      true,
    );
    const includeOverdue = await this.settings.getBooleanForKey(
      SK.PHONE_ALERTS_INCLUDE_OVERDUE,
      true,
    );
    return { enabled, includeDue, includeOverdue };
  }

  async sendDailyReminder(
    now: Date = new Date(),
    tz?: string,
  ): Promise<void> {
    const cfg = await this.resolveConfig();
    if (!cfg.enabled) return;

    const openAll = await this.maintenance.listOpen();
    const open = openAll.filter((t) => {
      if (t.status === 'DUE' && !cfg.includeDue) return false;
      if (t.status === 'OVERDUE' && !cfg.includeOverdue) return false;
      return true;
    });
    if (open.length === 0) return;

    // Idempotency: one successful log row per calendar day in the
    // configured business timezone — not UTC — so a 09:00 reminder in
    // Europe/Kyiv does not race with the previous day's 09:00 reminder
    // when the UTC calendar day rolls over mid-ping.
    const resolvedTz = tz ?? (await this.resolveTimezone());
    const todayDate = getLocalDateMidnightUtc(now, resolvedTz);
    const alreadySent = await this.prisma.phoneReminderLog.findUnique({
      where: { sentOn: todayDate },
    });
    if (alreadySent && alreadySent.success) return;

    const uiUrl = this.config.get<string>('FRONTEND_URL') ?? '';
    const lines = open.slice(0, 20).map((t) => {
      const needs: string[] = [];
      if (!t.networkRegisteredAt) needs.push('register');
      if (!t.toppedUpAt) needs.push('top up');
      const operator = t.phoneNumber.operator;
      const due = t.dueAt.toISOString().slice(0, 10);
      return `• ${maskPhone(t.phoneNumber.number)} · ${operator} · due ${due} · ${needs.join(' + ')}`;
    });
    const extra = open.length > 20 ? `\n… and ${open.length - 20} more` : '';

    try {
      const profile = await this.prisma.discordProfile.findFirst({
        where: { active: true },
        select: {
          name: true,
          opsChannelId: true,
          managerRoleId: true,
        },
      });
      if (!profile) {
        throw new Error(
          'No active DiscordProfile — phone maintenance reminder cannot be delivered',
        );
      }
      if (!profile.opsChannelId) {
        throw new Error(
          `Active DiscordProfile "${profile.name}" has no opsChannelId — phone maintenance reminder cannot be delivered`,
        );
      }

      const mentionPrefix = profile.managerRoleId
        ? `<@&${profile.managerRoleId}>\n`
        : '';
      const content =
        mentionPrefix +
        `**${open.length} phone number${open.length === 1 ? '' : 's'} require maintenance.** ` +
        `Insert the SIMs, confirm network registration and top up balances.\n` +
        lines.join('\n') +
        extra +
        (uiUrl
          ? `\n\n→ ${uiUrl.replace(/\/$/, '')}/phone-numbers/maintenance`
          : '');

      // Only the managerRoleId is allowed to ping; everything else
      // (@everyone, @here, @user, any other role id that might appear
      // inside a task line) is suppressed by `parse: []`.
      const allowedMentions: Record<string, unknown> = profile.managerRoleId
        ? { parse: [], roles: [profile.managerRoleId] }
        : { parse: [] };

      const resp = await this.bot.postMessage({
        channelId: profile.opsChannelId,
        content,
        allowedMentions,
      });
      if (!resp.ok) {
        throw new Error(`Discord postMessage ${resp.status}: ${resp.message}`);
      }

      await this.prisma.phoneReminderLog.upsert({
        where: { sentOn: todayDate },
        create: {
          sentOn: todayDate,
          taskCount: open.length,
          success: true,
        },
        update: {
          taskCount: open.length,
          success: true,
          error: null,
        },
      });
      // Bump reminderCount on the included tasks so UI can show "nagged N times".
      await this.prisma.phoneMaintenance.updateMany({
        where: { id: { in: open.map((t) => t.id) } },
        data: {
          lastReminderAt: new Date(),
          reminderCount: { increment: 1 },
        },
      });
      await this.audit.recordSafe({
        actorUserId: null,
        actorType: 'SYSTEM',
        domain: 'SETTINGS',
        action: 'phone.maintenance.reminder.sent',
        targetType: 'PhoneMaintenance',
        targetLabel: `${open.length} open tasks`,
        result: AuditResult.SUCCESS,
      });
      this.logger.log(
        `Sent phone maintenance reminder for ${open.length} tasks via profile ${profile.name}`,
      );
    } catch (err) {
      const message = sanitiseError((err as Error).message);
      try {
        await this.prisma.phoneReminderLog.upsert({
          where: { sentOn: todayDate },
          create: {
            sentOn: todayDate,
            taskCount: open.length,
            success: false,
            error: message,
          },
          update: {
            taskCount: open.length,
            success: false,
            error: message,
          },
        });
      } catch (logErr) {
        this.logger.error(
          `failed to persist reminder log: ${(logErr as Error).message}`,
        );
      }
      await this.audit.recordSafe({
        actorUserId: null,
        actorType: 'SYSTEM',
        domain: 'SETTINGS',
        action: 'phone.maintenance.reminder.failed',
        targetType: 'PhoneMaintenance',
        targetLabel: `${open.length} open tasks`,
        result: AuditResult.FAILED,
        severity: AuditSeverity.WARNING,
        metadata: { reason: message },
      });
      this.logger.error(
        `phone maintenance reminder failed: ${message}`,
      );
    }
  }

  /**
   * One-off ping to the active DiscordProfile's opsChannelId. Does
   * NOT touch the daily-idempotency log and does NOT bump
   * reminderCount on tasks — it just verifies that bot + profile +
   * channel + role are configured correctly end to end.
   */
  async sendTestPing(): Promise<{ success: boolean; message?: string }> {
    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: { name: true, opsChannelId: true, managerRoleId: true },
    });
    if (!profile) {
      return {
        success: false,
        message: 'No active DiscordProfile — activate TEST or PRODUCTION first.',
      };
    }
    if (!profile.opsChannelId) {
      return {
        success: false,
        message: `Active DiscordProfile "${profile.name}" has no opsChannelId.`,
      };
    }
    const mentionPrefix = profile.managerRoleId
      ? `<@&${profile.managerRoleId}>\n`
      : '';
    const content =
      mentionPrefix +
      '**Phone maintenance alerts — test ping.** ' +
      'If you see this message, the bot has access to the Ops channel.';
    const allowedMentions: Record<string, unknown> = profile.managerRoleId
      ? { parse: [], roles: [profile.managerRoleId] }
      : { parse: [] };
    const resp = await this.bot.postMessage({
      channelId: profile.opsChannelId,
      content,
      allowedMentions,
    });
    if (!resp.ok) {
      return {
        success: false,
        message: sanitiseError(`${resp.status}: ${resp.message}`),
      };
    }
    return { success: true };
  }
}

function sanitiseError(message: string | undefined | null): string {
  if (!message) return 'unknown';
  return message
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot <redacted>')
    .replace(/\/webhooks\/(\d{17,20})\/[^\/\s]+/g, '/webhooks/$1/<redacted>')
    .slice(0, 240);
}
