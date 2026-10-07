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
@Injectable()
export class DiscordEmbedBuilderService {
  readonly COLOR_GREEN = 5763719;
  readonly COLOR_YELLOW = 15844367;
  readonly COLOR_RED = 15548997;
  readonly COLOR_BLUE = 3447003;

  reportEmbed(args: {
    projectName: string;
    authorName: string;
    hours: number;
    reportDate: Date;
    text: string;
    isLate: boolean;
  }): DiscordEmbed {
    return normaliseEmbed({
      title: `📋 Daily report — ${args.projectName}`,
      color: args.isLate ? this.COLOR_YELLOW : this.COLOR_GREEN,
      author: { name: args.authorName },
      fields: [
        { name: '🕒 Hours', value: String(args.hours), inline: true },
        { name: '📅 Date', value: this.iso(args.reportDate), inline: true },
        { name: '📝 Details', value: args.text, inline: false },
      ],
      footer: { text: args.isLate ? 'Saved · marked LATE' : 'Saved' },
    });
  }

  lateReportEmbed(args: {
    projectName: string;
    authorName: string;
    hours: number;
    reportDate: Date;
    text: string;
    submittedAt: Date;
  }): DiscordEmbed {
    return normaliseEmbed({
      title: `⏰ Late report — ${args.projectName}`,
      color: this.COLOR_YELLOW,
      author: { name: args.authorName },
      fields: [
        { name: '🕒 Hours', value: String(args.hours), inline: true },
        { name: '📅 For date', value: this.iso(args.reportDate), inline: true },
        { name: '🕘 Submitted at', value: args.submittedAt.toISOString(), inline: false },
        { name: '📝 Details', value: args.text, inline: false },
      ],
    });
  }

  dailyDigestEmbeds(args: {
    reportDate: Date;
    rows: Array<{ projectName: string; authorName: string; hours: number }>;
  }): DiscordEmbed[] {
    return args.rows.map((r) =>
      normaliseEmbed({
        title: r.projectName,
        description: `${r.hours} hours — ${r.authorName}`,
        color: r.hours > 6 ? this.COLOR_GREEN : this.COLOR_RED,
      }),
    );
  }

  weeklyDigestEmbeds(rows: Array<{ projectName: string; hours: number }>): DiscordEmbed[] {
    // Threshold is strict `>34`: matches the legacy admin's weekly
    // report colour rule exactly. A project that lands on 34.00 hours
    // is red, as it has been since the old backend.
    return rows.map((r) =>
      normaliseEmbed({
        title: r.projectName,
        description: `${r.hours.toFixed(2)} hours`,
        color: r.hours > 34 ? this.COLOR_GREEN : this.COLOR_RED,
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
