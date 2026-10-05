import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditResult, AuditSeverity } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { StorageBucket, StorageService } from '../storage';
import { LoginDto } from './dto/login.dto';

const REFRESH_TOKEN_EXPIRY = '30d';

export interface AuditRequestContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditEventService,
    private readonly storage: StorageService,
  ) {}

  // ─── Private helpers ─────────────────────────────────────────────────────────

  // JWT carries identity only. Role and permissions are resolved
  // from the DB per protected request by `PermissionGuard`.
  private generateTokens(userId: string, email: string) {
    const payload = { sub: userId, email };

    const accessToken = this.jwt.sign(payload);

    const refreshToken = this.jwt.sign(payload, {
      secret: process.env.JWT_REFRESH_SECRET,
      expiresIn: REFRESH_TOKEN_EXPIRY,
    });

    return { accessToken, refreshToken };
  }

  private async saveRefreshToken(userId: string, refreshToken: string) {
    const hash = await bcrypt.hash(refreshToken, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: hash },
    });
  }

  // ─── Public methods ───────────────────────────────────────────────────────────

  async login(dto: LoginDto, ctx: AuditRequestContext = {}) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      await this.audit.recordSafe({
        actorUserId: null,
        actorEmail: dto.email,
        domain: 'AUTH',
        action: 'auth.login',
        targetType: 'User',
        targetLabel: dto.email,
        result: AuditResult.FAILED,
        severity: AuditSeverity.WARNING,
        metadata: { reason: 'unknown_email' },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId ?? null,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isValid) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        actorEmail: user.email,
        actorName: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || null,
        domain: 'AUTH',
        action: 'auth.login',
        targetType: 'User',
        targetId: user.id,
        targetLabel: user.email,
        result: AuditResult.FAILED,
        severity: AuditSeverity.WARNING,
        metadata: { reason: 'bad_password' },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId ?? null,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = this.generateTokens(user.id, user.email);
    await this.saveRefreshToken(user.id, tokens.refreshToken);

    await this.audit.recordSafe({
      actorUserId: user.id,
      actorEmail: user.email,
      actorName: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || null,
      domain: 'AUTH',
      action: 'auth.login',
      targetType: 'User',
      targetId: user.id,
      targetLabel: user.email,
      result: AuditResult.SUCCESS,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId ?? null,
    });

    return tokens;
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; email: string };

    try {
      payload = this.jwt.verify(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user?.refreshTokenHash) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenMatches = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!tokenMatches) throw new UnauthorizedException('Invalid refresh token');

    const tokens = this.generateTokens(user.id, user.email);
    await this.saveRefreshToken(user.id, tokens.refreshToken);

    return tokens;
  }

  async logout(userId: string, ctx: AuditRequestContext = {}) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });
    await this.audit.recordSafe({
      actorUserId: userId,
      actorEmail: user?.email ?? null,
      actorName:
        `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || null,
      domain: 'AUTH',
      action: 'auth.logout',
      targetType: 'User',
      targetId: userId,
      targetLabel: user?.email ?? null,
      result: AuditResult.SUCCESS,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId ?? null,
    });
  }

  // Loads the caller's identity, role and permissions from the DB per
  // request (spec §2, §3.1). Same policy as `PermissionGuard`; no
  // in-memory cache in this feature.
  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        avatarKey: true,
        roleRef: {
          select: {
            id: true,
            name: true,
            label: true,
            permissions: {
              select: { permission: { select: { key: true } } },
            },
          },
        },
      },
    });

    if (!user) throw new UnauthorizedException('User not found');

    const role = user.roleRef
      ? { id: user.roleRef.id, name: user.roleRef.name, label: user.roleRef.label }
      : null;
    const permissions = user.roleRef?.permissions.map((rp) => rp.permission.key) ?? [];

    // `avatarUrl` on the wire:
    //   - preset avatars store their DiceBear URL directly in
    //     `avatarUrl` (and `avatarKey = "preset:<id>"`); we hand that
    //     back untouched.
    //   - uploaded avatars live in a private B2 bucket, so we mint a
    //     fresh signed URL per request from `avatarKey`.
    //   - legacy rows may have a stored permanent URL and no key —
    //     we try to recover the key from that URL.
    let resolvedAvatarUrl: string | null = null;
    if (user.avatarKey?.startsWith('preset:')) {
      resolvedAvatarUrl = user.avatarUrl;
    } else {
      const key =
        user.avatarKey ??
        (user.avatarUrl ? this.storage.extractKeyFromLegacyUrl(user.avatarUrl) : null);
      if (key) {
        try {
          resolvedAvatarUrl = await this.storage.getDownloadUrl(
            StorageBucket.AVATARS,
            key,
          );
        } catch {
          // Avatar is not critical — degrade gracefully to no avatar
          // rather than failing /auth/me.
          resolvedAvatarUrl = null;
        }
      }
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: resolvedAvatarUrl,
      role,
      permissions,
    };
  }

  /** Update the current user's own display name. No permission beyond
   *  authentication — a user can always edit their own identity. Email
   *  stays immutable through this surface. */
  async updateMe(
    userId: string,
    dto: { firstName?: string; lastName?: string },
  ) {
    const data: Record<string, string> = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName.trim();
    if (dto.lastName !== undefined) data.lastName = dto.lastName.trim();
    if (Object.keys(data).length === 0) return this.getMe(userId);
    await this.prisma.user.update({ where: { id: userId }, data });
    return this.getMe(userId);
  }

  /**
   * Persist a new avatar.
   *
   * Preset avatars pass `isPreset: true` and ship their DiceBear URL
   * in `avatarUrl`. Uploaded avatars pass only `avatarKey`; we never
   * store a B2 URL as a permanent field — the signed URL is minted
   * per request in `getMe()`.
   */
  async setAvatar(
    userId: string,
    args: { avatarKey: string; avatarUrl?: string | null; isPreset?: boolean },
  ) {
    const avatarUrl = args.isPreset ? args.avatarUrl ?? null : null;
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarKey: args.avatarKey, avatarUrl },
    });
    return this.getMe(userId);
  }

  async getAvatarKey(userId: string): Promise<string | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarKey: true },
    });
    return row?.avatarKey ?? null;
  }

  async clearAvatar(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: null, avatarKey: null },
    });
    return this.getMe(userId);
  }
}
