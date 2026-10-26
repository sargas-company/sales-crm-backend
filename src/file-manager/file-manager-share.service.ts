import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditResult, FileManagerShareResourceType } from '@prisma/client';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';

import type {
  CreateDirectShareDto,
  CreateInviteDto,
  ShareBlueprintDto,
  UpdateShareDto,
} from './dto/share.dto';

/* Admin-side share + invite management. Portal-side consumption of
 * invites lives in `PortalAuthService` (couples with Discord OAuth). */
@Injectable()
export class FileManagerShareService {
  private readonly logger = new Logger(FileManagerShareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  /* ── Direct share (admin → existing portal user) ──────────────── */

  async createDirectShare(dto: CreateDirectShareDto, actorUserId: string) {
    await this.ensureResourceExists(dto.share.resourceType, dto.share.resourceId);
    const target = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!target) throw new NotFoundException('target user not found');
    if (!target.isPortalUser) {
      throw new BadRequestException('target user is not a portal user');
    }

    /* upsert — if share exists, overwrite perms. */
    const row = await this.prisma.fileManagerShare.upsert({
      where: {
        userId_resourceType_resourceId: {
          userId: dto.userId,
          resourceType: dto.share.resourceType,
          resourceId: dto.share.resourceId,
        },
      },
      create: {
        userId: dto.userId,
        resourceType: dto.share.resourceType,
        resourceId: dto.share.resourceId,
        recursive: dto.share.recursive,
        canDownload: dto.share.canDownload,
        canUpload: dto.share.canUpload,
        canCreateSubfolders: dto.share.canCreateSubfolders,
        grantedById: actorUserId,
      },
      update: {
        recursive: dto.share.recursive,
        canDownload: dto.share.canDownload,
        canUpload: dto.share.canUpload,
        canCreateSubfolders: dto.share.canCreateSubfolders,
        grantedById: actorUserId,
      },
    });

    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.share.grant',
      targetType: 'FileManagerShare',
      targetId: row.id,
      targetLabel: `${dto.share.resourceType}:${dto.share.resourceId}`,
      result: AuditResult.SUCCESS,
      metadata: {
        recipientUserId: dto.userId,
        resourceType: dto.share.resourceType,
        resourceId: dto.share.resourceId,
        recursive: dto.share.recursive,
      },
    });
    return row;
  }

  async updateShare(id: string, dto: UpdateShareDto, actorUserId: string) {
    const existing = await this.prisma.fileManagerShare.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('share not found');
    const row = await this.prisma.fileManagerShare.update({
      where: { id },
      data: {
        recursive: dto.recursive ?? existing.recursive,
        canDownload: dto.canDownload ?? existing.canDownload,
        canUpload: dto.canUpload ?? existing.canUpload,
        canCreateSubfolders:
          dto.canCreateSubfolders ?? existing.canCreateSubfolders,
      },
    });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.share.edit',
      targetType: 'FileManagerShare',
      targetId: id,
      targetLabel: `${existing.resourceType}:${existing.resourceId}`,
      result: AuditResult.SUCCESS,
      metadata: {
        recipientUserId: existing.userId,
        before: {
          recursive: existing.recursive,
          canDownload: existing.canDownload,
          canUpload: existing.canUpload,
          canCreateSubfolders: existing.canCreateSubfolders,
        },
        after: {
          recursive: row.recursive,
          canDownload: row.canDownload,
          canUpload: row.canUpload,
          canCreateSubfolders: row.canCreateSubfolders,
        },
      },
    });
    return row;
  }

  async revokeShare(id: string, actorUserId: string) {
    const existing = await this.prisma.fileManagerShare.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('share not found');
    await this.prisma.fileManagerShare.delete({ where: { id } });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.share.revoke',
      targetType: 'FileManagerShare',
      targetId: id,
      targetLabel: `${existing.resourceType}:${existing.resourceId}`,
      result: AuditResult.SUCCESS,
      metadata: {
        recipientUserId: existing.userId,
      },
    });
    return { id };
  }

  /** Shares on a given folder OR file — admin UI reads this when
   *  opening the Share modal to show "who has access". */
  async listSharesOnResource(
    resourceType: FileManagerShareResourceType,
    resourceId: string,
  ) {
    const rows = await this.prisma.fileManagerShare.findMany({
      where: { resourceType, resourceId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            discordId: true,
            active: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows;
  }

  /* ── Portal users (admin side) ────────────────────────────────── */

  async listPortalUsers() {
    const rows = await this.prisma.user.findMany({
      where: { isPortalUser: true },
      select: {
        id: true,
        email: true,
        displayName: true,
        firstName: true,
        avatarUrl: true,
        discordId: true,
        active: true,
        createdAt: true,
        _count: { select: { fileManagerSharesReceived: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows;
  }

  async getPortalUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        firstName: true,
        avatarUrl: true,
        discordId: true,
        active: true,
        isPortalUser: true,
        createdAt: true,
        fileManagerSharesReceived: {
          include: {
            grantedBy: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!user || !user.isPortalUser) {
      throw new NotFoundException('portal user not found');
    }
    /* Resolve resource names on each share for display. */
    const sharesEnriched: Array<
      (typeof user.fileManagerSharesReceived)[number] & { resourceName: string | null }
    > = []
    for (const s of user.fileManagerSharesReceived) {
      const name =
        s.resourceType === 'FOLDER'
          ? (
              await this.prisma.fileManagerFolder.findUnique({
                where: { id: s.resourceId },
                select: { name: true },
              })
            )?.name ?? null
          : (
              await this.prisma.fileManagerFile.findUnique({
                where: { id: s.resourceId },
                select: { originalName: true },
              })
            )?.originalName ?? null
      sharesEnriched.push({ ...s, resourceName: name })
    }
    return { ...user, fileManagerSharesReceived: sharesEnriched }
  }

  async terminatePortalUser(userId: string, actorUserId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isPortalUser) {
      throw new NotFoundException('portal user not found');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { active: false },
    });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.portal_user.terminate',
      targetType: 'User',
      targetId: userId,
      targetLabel: user.email,
      result: AuditResult.SUCCESS,
    });
    return { id: userId, active: false };
  }

  async reactivatePortalUser(userId: string, actorUserId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isPortalUser) {
      throw new NotFoundException('portal user not found');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { active: true },
    });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.portal_user.reactivate',
      targetType: 'User',
      targetId: userId,
      targetLabel: user.email,
      result: AuditResult.SUCCESS,
    });
    return { id: userId, active: true };
  }

  /* ── Invites (admin side) ─────────────────────────────────────── */

  async createInvite(dto: CreateInviteDto, actorUserId: string) {
    /* Validate all resources exist and are reachable before committing. */
    for (const s of dto.shares) {
      await this.ensureResourceExists(s.resourceType, s.resourceId);
    }
    const token = this.generateToken();
    const expiresAt =
      dto.expiresInDays && dto.expiresInDays > 0
        ? new Date(Date.now() + dto.expiresInDays * 24 * 60 * 60 * 1000)
        : null;
    const row = await this.prisma.fileManagerInvite.create({
      data: {
        token,
        createdById: actorUserId,
        sharesJson: dto.shares as unknown as object,
        note: dto.note,
        expiresAt,
      },
    });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.invite.create',
      targetType: 'FileManagerInvite',
      targetId: row.id,
      targetLabel: `${dto.shares.length} share(s)`,
      result: AuditResult.SUCCESS,
      metadata: {
        shareCount: dto.shares.length,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });
    return {
      id: row.id,
      token: row.token,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      shareCount: dto.shares.length,
    };
  }

  async revokeInvite(id: string, actorUserId: string) {
    const invite = await this.prisma.fileManagerInvite.findUnique({ where: { id } });
    if (!invite) throw new NotFoundException('invite not found');
    if (invite.usedAt) {
      throw new BadRequestException(
        'invite already used — remove the resulting shares instead',
      );
    }
    await this.prisma.fileManagerInvite.delete({ where: { id } });
    await this.audit.record({
      actorUserId,
      domain: 'SETTINGS',
      action: 'file_manager.invite.revoke',
      targetType: 'FileManagerInvite',
      targetId: id,
      targetLabel: invite.token.slice(0, 8),
      result: AuditResult.SUCCESS,
    });
    return { id };
  }

  async listInvites() {
    return this.prisma.fileManagerInvite.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        createdBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        usedByUser: {
          select: { id: true, email: true, displayName: true, avatarUrl: true },
        },
      },
    });
  }

  /* ── Helpers ──────────────────────────────────────────────────── */

  private async ensureResourceExists(
    type: ShareBlueprintDto['resourceType'],
    id: string,
  ) {
    if (type === 'FOLDER') {
      const f = await this.prisma.fileManagerFolder.findUnique({ where: { id } });
      if (!f) throw new NotFoundException(`folder ${id} not found`);
    } else {
      const f = await this.prisma.fileManagerFile.findUnique({ where: { id } });
      if (!f) throw new NotFoundException(`file ${id} not found`);
    }
  }

  private generateToken(): string {
    /* 32 random bytes → 43-char URL-safe base64. Fits comfortably in
     * an invite URL and has 256-bit entropy. */
    return randomBytes(32).toString('base64url');
  }
}
