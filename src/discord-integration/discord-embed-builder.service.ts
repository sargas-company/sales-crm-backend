import { Injectable } from '@nestjs/common';

import { normaliseEmbed, type DiscordEmbed } from './discord-chunking';

/**
 * Pure functions that build the Discord-embed objects used by the
 * scheduler, the interactions controller and the Settings "Send
 * preview" action. Pulled into one place so the preview matches
 * what the scheduler would actually send.
 *
 * Every builder returns a `normaliseEmbed`-safe object: title ≤256,
 * description ≤4096, field.name ≤256, field.value ≤1024, up to 25
 * fields, footer.text ≤2048, author.name ≤256. Chunking (10-embed
 * cap, 6000-char total) is a separate concern handled by the sender.
 */
/**
 * Legacy admin accent colors — the two shades every ProjectReport
 * notification uses. Hex values are preserved verbatim from the old
 * Laravel app (NotificationController::sendDailyReport /
 * sendWeeklyReport), so a message delivered now looks identical to
 * one delivered by that admin.
 *
 * Any other hue (green, yellow, Discord blurple 0x3498DB, …) is NOT
 * used for ProjectReport-shaped messages. Non-report flows
 * (absences, weekly off-day digests, reminders, scanner, etc.) are
 * out of scope and keep their own palettes.
 */
export const LEGACY_BLUE = 7506394; // 0x7289DA
export const LEGACY_RED = 11471113; // 0xAF0909

/** Daily/Late share one strict threshold inherited from Laravel's
 *  `NotificationController::sendDailyReport`: `hours > 6` → blue,
 *  otherwise red. A report at exactly 6.00 hours stays red. */
export const DAILY_REPORT_HOURS_THRESHOLD = 6;

/** Weekly keeps Laravel's `sendWeeklyReport` rule: `hours > 34` →
 *  blue. Exactly 34.00 hours is red. */
export const WEEKLY_REPORT_HOURS_THRESHOLD = 34;

/**
 * Color helper used by every compact ProjectReport card
 * (daily digest + late report). Centralised so the two paths cannot
 * drift and so the strict `>` comparator is written exactly once.
 */
export const reportColorForHours = (
  hours: number,
  threshold: number = DAILY_REPORT_HOURS_THRESHOLD,
): number => (hours > threshold ? LEGACY_BLUE : LEGACY_RED);

@Injectable()
export class DiscordEmbedBuilderService {
  // Non-report palette constants kept for other builders in this file
  // (reminderContent, absencesEmbeds). They are NOT used by report
  // cards and must stay unused by the compact / daily / late paths.
  readonly COLOR_RED = 15548997;
  readonly COLOR_BLUE = 3447003;

  readonly LEGACY_BLUE = LEGACY_BLUE;
  readonly LEGACY_RED = LEGACY_RED;

  /**
   * Project-channel embed posted by `/report`. The report is a
   * team-level record — the embed no longer carries a per-author
   * byline. Submitter identity stays only in the audit trail.
   *
   * Color is ALWAYS `LEGACY_BLUE`, regardless of `isLate` or
   * `hours`. The working-channel surface must never go red: the
   * red/blue split lives only on PMS compact cards.
   */
  reportEmbed(args: {
    projectName: string;
    hours: number;
    reportDate: Date;
    text: string;
    isLate: boolean;
  }): DiscordEmbed {
    return normaliseEmbed({
      title: `📋 Daily report — ${args.projectName}`,
      color: LEGACY_BLUE,
      fields: [
        { name: '🕒 Hours', value: String(args.hours), inline: true },
        { name: '📅 Date', value: this.iso(args.reportDate), inline: true },
        { name: '📝 Details', value: args.text, inline: false },
      ],
      footer: {
        text: args.isLate
          ? 'Posted via Discord · marked LATE'
          : 'Posted via Discord',
      },
    });
  }

  /**
   * Single compact PMS report card — the shared shape used by the
   * 19:00 digest row AND by every late-report PMS message. Does
   * NOT render the report body, submitted-at, author, meeting URL
   * or any of the detailed project-channel fields.
   */
  compactReportCard(args: {
    projectName: string;
    hours: number;
  }): DiscordEmbed {
    return normaliseEmbed({
      title: args.projectName,
      description: `${args.hours} hours`,
      color: reportColorForHours(args.hours, DAILY_REPORT_HOURS_THRESHOLD),
    });
  }

  /**
   * 19:00 PMS digest = N × `compactReportCard`, one per report row,
   * in the caller-supplied order. Chunking (10 embeds / 6000 chars)
   * is the sender's concern.
   */
  dailyDigestEmbeds(args: {
    reportDate: Date;
    rows: Array<{ projectName: string; hours: number }>;
  }): DiscordEmbed[] {
    return args.rows.map((r) =>
      this.compactReportCard({ projectName: r.projectName, hours: r.hours }),
    );
  }

  weeklyDigestEmbeds(
    rows: Array<{ projectName: string; hours: number }>,
  ): DiscordEmbed[] {
    // Threshold is strict `>34`; a project landing on 34.00 is red.
    // Zero-hour projects stay in the list (red) — mirrors the old
    // Laravel admin.
    return rows.map((r) =>
      normaliseEmbed({
        title: r.projectName,
        description: `${r.hours.toFixed(2)} hours`,
        color: reportColorForHours(r.hours, WEEKLY_REPORT_HOURS_THRESHOLD),
      }),
    );
  }

  birthdayContent(names: string[]): string {
    return names.length
      ? `Hey @everyone! Today is ${names.join(', ')}'s birthday. Congratulations!`
      : 'No birthdays today.';
  }

  /**
   * 18:00 reminder content. Includes the CRM reports page URL when
   * configured (restores legacy admin parity); strict mentions are
   * applied by the caller via `allowedMentions.roles`.
   */
  reminderContent(managerRoleId: string | null, reportsUrl?: string): string {
    const prefix = managerRoleId ? `<@&${managerRoleId}>, ` : '';
    const suffix = reportsUrl ? ` ${reportsUrl}` : '';
    return `${prefix}please file the daily reports.${suffix}`;
  }

  absencesEmbeds(
    rows: Array<{ type: string; firstName: string; lastName: string; endDate: Date }>,
  ): DiscordEmbed[] {
    return rows.map((o) =>
      normaliseEmbed({
        title:
          (o.type === 'VACATION' ? '🏖️ ' : o.type === 'SICK_LEAVE' ? '🤒 ' : '🏠 ') +
          `${o.firstName} ${o.lastName}`,
        description: `${o.type} (till ${this.iso(o.endDate)})`,
        color:
          o.type === 'VACATION' ? this.COLOR_BLUE :
          o.type === 'SICK_LEAVE' ? this.COLOR_RED : 0x95a5a6,
      }),
    );
  }

  private iso(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
