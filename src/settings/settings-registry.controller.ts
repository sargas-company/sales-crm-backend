import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AuditResult, AuditSeverity } from '@prisma/client';
import type { Request as ExpressRequest } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { AuthUser } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { DiscordBotClient } from '../discord-integration/discord-bot.client';

import { SettingsService } from './settings.service';
import { RegistrySection, SK } from './settings-registry';

interface UpdateSectionBody {
  section: RegistrySection;
  values: Record<string, unknown>;
}

const extractCtx = (req: ExpressRequest) => ({
  ip:
    (req.ip || req.headers['x-forwarded-for'] || '')
      .toString()
      .split(',')[0] || null,
  userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
});

@ApiTags('Settings · Registry')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('settings-registry')
export class SettingsRegistryController {
  constructor(
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
    private readonly config: ConfigService,
    private readonly bot: DiscordBotClient,
  ) {}

  /** List every section + entry the caller is allowed to see. */
  @Get('sections')
  @RequirePermission('settings:view')
  @ApiOperation({
    summary: 'List resolved settings grouped by section, filtered by permission.',
  })
  async listSections(@Req() req: { user: AuthUser }) {
    return this.settings.listSectionsFor(req.user.permissions);
  }

  /** Patch all values in one section atomically. */
  @Patch('sections')
  @RequirePermission('settings:view')
  @ApiOperation({ summary: 'Update one section — validates every key.' })
  async updateSection(
    @Body() body: UpdateSectionBody,
    @Req() req: ExpressRequest & { user: AuthUser },
  ) {
    if (!body?.section || !body?.values) {
      throw new BadRequestException('section and values are required');
    }
    const { changes } = await this.settings.applySectionUpdate(
      body.section,
      body.values,
      req.user.permissions,
    );

    // Audit.
    const ctx = extractCtx(req);
    if (Object.keys(changes).length > 0) {
      await this.audit.recordSafe({
        actorUserId: req.user.id,
        domain: 'SETTINGS',
        action: 'settings.changed',
        targetType: 'SettingsSection',
        targetId: body.section,
        targetLabel: body.section,
        result: AuditResult.SUCCESS,
        severity: this.severityForSection(body.section),
        changes: Object.fromEntries(
          Object.entries(changes).map(([k, v]) => [k, v]),
        ) as unknown as Record<string, { before: unknown; after: unknown }>,
        metadata: {
          section: body.section,
          keys: Object.keys(changes),
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
    }

    // Return the fresh section view so the UI re-renders without
    // a second round-trip.
    const sections = await this.settings.listSectionsFor(
      req.user.permissions,
    );
    return (
      sections.find((s) => s.key === body.section) ?? {
        key: body.section,
        entries: [],
      }
    );
  }

  /** Status overview for the top of the Settings page. */
  @Get('status')
  @RequirePermission('settings:view')
  @ApiOperation({
    summary:
      'Operational status: Scanner, Vibe Worker, Discord, Vault — real values only.',
  })
  async status() {
    const [
      ingestionEnabled,
      analysisEnabled,
      discordAlertsEnabled,
      scoreThreshold,
      lastIngest,
      lastProcessed,
      activeVaultSessions,
    ] = await Promise.all([
      this.settings.getBooleanForKey(SK.SCANNER_INGESTION_ENABLED, true),
      this.settings.getBooleanForKey(SK.SCANNER_ANALYSIS_ENABLED, true),
      this.settings.getBooleanForKey(SK.SCANNER_DISCORD_ALERTS_ENABLED, true),
      this.settings.getNumberForKey(SK.SCANNER_DISCORD_SCORE_THRESHOLD, 50),
      this.prisma.jobPostIngestEvent.findFirst({
        orderBy: { receivedAt: 'desc' },
        select: { id: true, receivedAt: true },
      }),
      this.prisma.jobPost.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true, status: true, matchScore: true },
      }),
      this.countActiveVaultSessions(),
    ]);

    // "Configured" means: the bot token is set in env AND there is
    // an active DiscordProfile with at least one channel wired up.
    // Backup/infrastructure scripts use DISCORD_OPS_WEBHOOK_URL
    // outside this process; nothing here reads it.
    const botTokenSet = !!this.config.get<string>('DISCORD_BOT_TOKEN');
    const activeProfile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: {
        salesChannelId: true,
        pmsChannelId: true,
        opsChannelId: true,
      },
    });
    const discordConfigured =
      botTokenSet &&
      !!activeProfile &&
      !!(
        activeProfile.salesChannelId ||
        activeProfile.pmsChannelId ||
        activeProfile.opsChannelId
      );
    // The Vibe Worker webhook is now public (its UI cannot send
    // custom headers), so there is no secret to key "configured" on.
    // We surface `scanner.ingestionEnabled` instead — that is the
    // only switch that actually gates traffic into the endpoint.
    const vibeConfigured = ingestionEnabled;

    return {
      scanner: {
        ingestionEnabled,
        analysisEnabled,
      },
      vibeWorker: {
        configured: vibeConfigured,
        lastEventReceivedAt: lastIngest?.receivedAt.toISOString() ?? null,
        lastEventId: lastIngest?.id ?? null,
      },
      jobPosts: {
        lastProcessedAt: lastProcessed?.createdAt.toISOString() ?? null,
        lastStatus: lastProcessed?.status ?? null,
        lastScore: lastProcessed?.matchScore ?? null,
      },
      discord: {
        configured: discordConfigured,
        alertsEnabled: discordAlertsEnabled,
        scoreThreshold,
        // Static list of what currently fires Discord traffic from
        // this process. Everything except backup alerts goes through
        // the active DiscordProfile + bot; backup alerts stay on the
        // DISCORD_OPS_WEBHOOK_URL so they still fire when Nest is
        // down.
        usedBy: [
          'Job post alerts (Sales channel)',
          'Client requests (PMS channel)',
          'Call reminders (PMS channel)',
          'Phone maintenance reminders (Ops channel)',
          'Backup failure alerts (DISCORD_OPS_WEBHOOK_URL)',
        ],
      },
      vault: {
        activeSessions: activeVaultSessions,
      },
    };
  }

  /**
   * Owner-only test notification.
   *
   * Routed through the active DiscordProfile's **opsChannelId** via
   * DiscordBotClient — the same channel the phone-maintenance
   * reminders use. No fallback to PMS or Sales: the test verifies the
   * Ops wiring specifically, and a silent re-route to a different
   * channel would mask a real misconfiguration. Mentions are
   * hard-disabled with `allowed_mentions.parse: []`.
   */
  @Post('integrations/discord/test')
  @RequirePermission('settings:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Send a test Discord notification to the active DiscordProfile Ops channel via the bot.',
  })
  async testDiscord(@Req() req: ExpressRequest & { user: AuthUser }) {
    const ctx = extractCtx(req);
    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: { name: true, opsChannelId: true },
    });
    if (!profile || !profile.opsChannelId) {
      const reason = profile
        ? `Active DiscordProfile "${profile.name}" has no opsChannelId configured`
        : 'No active DiscordProfile';
      await this.audit.recordSafe({
        actorUserId: req.user.id,
        domain: 'SETTINGS',
        action: 'integration.discord.test',
        targetType: 'Integration',
        targetLabel: 'Discord',
        result: AuditResult.FAILED,
        severity: AuditSeverity.INFO,
        metadata: { reason },
        ...ctx,
      });
      throw new BadRequestException(
        profile
          ? `Active DiscordProfile "${profile.name}" has no Ops channel configured. Set opsChannelId on the active profile first.`
          : 'No active DiscordProfile — activate TEST or PRODUCTION first.',
      );
    }
    const resp = await this.bot.postMessage({
      channelId: profile.opsChannelId,
      content: `Sargas CRM · test notification · ${new Date().toISOString()}`,
      allowedMentions: { parse: [] },
    });
    if (!resp.ok) {
      await this.audit.recordSafe({
        actorUserId: req.user.id,
        domain: 'SETTINGS',
        action: 'integration.discord.test',
        targetType: 'Integration',
        targetLabel: 'Discord',
        result: AuditResult.FAILED,
        severity: AuditSeverity.WARNING,
        metadata: { reason: `${resp.status}: ${resp.message}` },
        ...ctx,
      });
      throw new BadRequestException(
        `Discord test failed: ${resp.status} ${resp.message}`,
      );
    }
    await this.audit.recordSafe({
      actorUserId: req.user.id,
      domain: 'SETTINGS',
      action: 'integration.discord.test',
      targetType: 'Integration',
      targetLabel: 'Discord',
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.INFO,
      metadata: { profile: profile.name, channelId: profile.opsChannelId },
      ...ctx,
    });
    return { ok: true };
  }

  /** Owner-only: invalidate every live vault session. */
  @Post('vault/sessions/end-all')
  @RequirePermission('settings:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke every active vault session.' })
  async endAllVaultSessions(@Req() req: ExpressRequest & { user: AuthUser }) {
    const now = new Date();
    const result = await this.prisma.vaultSession.updateMany({
      where: { expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    const ctx = extractCtx(req);
    await this.audit.recordSafe({
      actorUserId: req.user.id,
      domain: 'SETTINGS',
      action: 'vault.sessions.endAll',
      targetType: 'VaultSession',
      targetLabel: `${result.count} sessions`,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.CRITICAL,
      metadata: { ended: result.count },
      ...ctx,
    });
    return { endedSessionCount: result.count };
  }

  private severityForSection(section: RegistrySection): AuditSeverity {
    if (
      section === 'payroll_compensation' ||
      section === 'credentials_security'
    ) {
      return AuditSeverity.WARNING;
    }
    if (section === 'scanner_alerts') return AuditSeverity.INFO;
    return AuditSeverity.INFO;
  }

  private async countActiveVaultSessions(): Promise<number> {
    try {
      return await this.prisma.vaultSession.count({
        where: { expiresAt: { gt: new Date() } },
      });
    } catch {
      // VaultSession model may not exist in some envs — swallow.
      return 0;
    }
  }
}
