import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditResult, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';

import type { DiscordProfile } from './discord.strategy';

/* ShareBlueprint — one share-to-create inside an invite's sharesJson
 * payload. Materialized into FileManagerShare rows when a worker
 * accepts the invite. */
export interface ShareBlueprint {
  resourceType: 'FOLDER' | 'FILE';
  resourceId: string;
  recursive: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canCreateSubfolders: boolean;
}

interface PortalLoginResult {
  accessToken: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

/* Portal auth — Discord-OAuth flow for File Manager Portal workers.
 * Admin login (email/password) stays in AuthService. */
@Injectable()
export class PortalAuthService {
  private readonly logger = new Logger(PortalAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditEventService,
  ) {}

  /** Called from the Discord OAuth callback. Three paths:
   *   1. discordId already bound to a User → log in (if active).
   *   2. discordId unknown, inviteToken present → consume invite,
   *      create portal user, materialize shares, log in.
   *   3. discordId unknown, no invite → reject. */
  async loginOrConsumeInvite(
    profile: DiscordProfile,
    inviteToken: string | null,
  ): Promise<PortalLoginResult> {
    const existing = await this.prisma.user.findUnique({
      where: { discordId: profile.discordId },
    });
    if (existing) {
      if (!existing.active) {
        throw new ForbiddenException('Account deactivated');
      }
      /* Also sync Discord avatar if we didn't have one. */
      const needsAvatarSync = !existing.avatarUrl && profile.avatarUrl;
      if (needsAvatarSync) {
        await this.prisma.user.update({
          where: { id: existing.id },
          data: { avatarUrl: profile.avatarUrl ?? undefined },
        });
      }
      return this.issueToken({
        id: existing.id,
        email: existing.email,
        displayName: existing.displayName,
        avatarUrl: needsAvatarSync ? profile.avatarUrl : existing.avatarUrl,
      });
    }

    if (!inviteToken) {
      throw new ForbiddenException(
        'You need an invite link to join Sargas Files Portal',
      );
    }
    return this.consumeInvite(profile, inviteToken);
  }

  /** Standalone invite-info endpoint — used by the landing page to
   *  render "You've been invited to..." before OAuth. Returns a
   *  stripped-down view that doesn't leak admin identity. */
  async readInvite(token: string) {
    const invite = await this.prisma.fileManagerInvite.findUnique({
      where: { token },
    });
    if (!invite) throw new NotFoundException('Invite not found or revoked');
    if (invite.usedAt) {
      throw new BadRequestException('This invite has already been used');
    }
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This invite has expired');
    }
    const blueprints = this.parseBlueprints(invite.sharesJson);
    /* Enrich each blueprint with the resource name so the landing
     * page can show "folder: project-A", "file: brief.pdf". */
    const enriched: Array<ShareBlueprint & { resourceName: string | null }> = []
    for (const b of blueprints) {
      const name = await this.resolveResourceName(b.resourceType, b.resourceId);
      enriched.push({ ...b, resourceName: name });
    }
    return {
      token: invite.token,
      shares: enriched,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      note: invite.note,
    };
  }

  private async consumeInvite(
    profile: DiscordProfile,
    inviteToken: string,
  ): Promise<PortalLoginResult> {
    const invite = await this.prisma.fileManagerInvite.findUnique({
      where: { token: inviteToken },
    });
    if (!invite) throw new NotFoundException('Invite not found or revoked');
    if (invite.usedAt) {
      throw new BadRequestException('This invite has already been used');
    }
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This invite has expired');
    }
    const blueprints = this.parseBlueprints(invite.sharesJson);
    if (blueprints.length === 0) {
      throw new BadRequestException('Invite has no shares to materialize');
    }

    /* Create portal user + shares + mark invite consumed in one tx. */
    const user = await this.prisma.$transaction(async (tx) => {
      /* Email collision strategy: if an existing admin User has the
       * same email, do NOT merge — create a separate portal user with
       * a suffixed internal email to keep the admin row untouched.
       * Admin and portal populations stay disjoint. */
      let email = profile.email ?? `discord-${profile.discordId}@portal.local`;
      const emailClash = await tx.user.findUnique({ where: { email } });
      if (emailClash) {
        email = `discord-${profile.discordId}@portal.local`;
      }
      const createdUser = await tx.user.create({
        data: {
          email,
          firstName: profile.username,
          lastName: '',
          displayName: profile.username,
          avatarUrl: profile.avatarUrl,
          discordId: profile.discordId,
          isPortalUser: true,
          active: true,
          /* passwordHash left null — portal users never log in with
           * email/password; see auth.service.ts guard. */
        },
      });
      for (const b of blueprints) {
        await tx.fileManagerShare.create({
          data: {
            userId: createdUser.id,
            resourceType: b.resourceType,
            resourceId: b.resourceId,
            recursive: b.recursive,
            canDownload: b.canDownload,
            canUpload: b.canUpload,
            canCreateSubfolders: b.canCreateSubfolders,
            grantedById: invite.createdById,
          },
        });
      }
      await tx.fileManagerInvite.update({
        where: { id: invite.id },
        data: { usedAt: new Date(), usedByUserId: createdUser.id },
      });
      return createdUser;
    });

    await this.audit.record({
      actorUserId: user.id,
      domain: 'SETTINGS',
      action: 'file_manager.invite.accept',
      targetType: 'FileManagerInvite',
      targetId: invite.id,
      targetLabel: `${blueprints.length} share(s)`,
      result: AuditResult.SUCCESS,
      metadata: {
        discordId: profile.discordId,
        inviteCreatedById: invite.createdById,
        shareCount: blueprints.length,
      },
    });

    return this.issueToken({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    });
  }

  private parseBlueprints(json: unknown): ShareBlueprint[] {
    if (!Array.isArray(json)) return [];
    const out: ShareBlueprint[] = [];
    for (const row of json) {
      if (
        row &&
        typeof row === 'object' &&
        (row as ShareBlueprint).resourceId &&
        (row as ShareBlueprint).resourceType
      ) {
        const r = row as ShareBlueprint;
        out.push({
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          recursive: !!r.recursive,
          canDownload: r.canDownload !== false,
          canUpload: !!r.canUpload,
          canCreateSubfolders: !!r.canCreateSubfolders,
        });
      }
    }
    return out;
  }

  private async resolveResourceName(
    type: 'FOLDER' | 'FILE',
    id: string,
  ): Promise<string | null> {
    if (type === 'FOLDER') {
      const row = await this.prisma.fileManagerFolder.findUnique({
        where: { id },
        select: { name: true },
      });
      return row?.name ?? null;
    }
    const row = await this.prisma.fileManagerFile.findUnique({
      where: { id },
      select: { originalName: true },
    });
    return row?.originalName ?? null;
  }

  private issueToken(user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  }): PortalLoginResult {
    const accessToken = this.jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: '15m' },
    );
    return { accessToken, user };
  }
}

// Narrow Prisma JSON helper
export type PrismaJson = Prisma.JsonValue;
