import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditResult } from '@prisma/client';
import type { Request, Response } from 'express';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { AuditEventService } from '../audit-event/audit-event.service';
import { AuthUser } from '../auth/auth-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { MfaService } from './mfa.service';
import { VaultRateLimiterService } from './rate-limiter.service';
import {
  VAULT_SESSION_COOKIE,
  VaultSessionService,
} from './vault-session.service';

function requestContext(req: Request) {
  return {
    ip: (req.ip || req.headers['x-forwarded-for'] || '').toString().split(',')[0] || null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
  };
}

interface UnlockDto {
  method: 'passkey' | 'totp' | 'recovery';
  code?: string;
  assertion?: AuthenticationResponseJSON;
}

interface PasskeyRegisterDto {
  response: RegistrationResponseJSON;
  deviceLabel?: string;
}

interface TotpConfirmDto {
  code: string;
}

@ApiTags('Vault')
@ApiBearerAuth('jwt')
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('vault')
export class VaultController {
  constructor(
    private readonly sessions: VaultSessionService,
    private readonly mfa: MfaService,
    private readonly rateLimit: VaultRateLimiterService,
    private readonly audit: AuditEventService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Status & lock/unlock ────────────────────────────────────────

  @Get('status')
  @RequirePermission('credentials:view')
  @ApiOperation({ summary: 'Vault state: MFA setup + current session TTL' })
  async status(@Req() req: Request & { user: AuthUser }) {
    const token = req.cookies?.[VAULT_SESSION_COOKIE];
    const [mfa, session] = await Promise.all([
      this.mfa.statusFor(req.user.id),
      this.sessions.peek(token, req.user.id),
    ]);
    return {
      mfa,
      session: session
        ? { id: session.id, expiresAt: session.expiresAt }
        : null,
    };
  }

  @Post('unlock')
  @RequirePermission('credentials:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step-up MFA. On success issues a VaultSession cookie (1h).',
  })
  async unlock(
    @Body() body: UnlockDto,
    @Req() req: Request & { user: AuthUser },
    @Res({ passthrough: true }) res: Response,
  ) {
    this.rateLimit.consume('vault.unlock', req.user.id, 8, 60_000);
    let ok = false;
    if (body.method === 'passkey') {
      if (!body.assertion) throw new BadRequestException('assertion required');
      ok = await this.mfa.completePasskeyAssertion(req.user.id, body.assertion);
    } else if (body.method === 'totp') {
      if (!body.code) throw new BadRequestException('code required');
      ok = await this.mfa.verifyTotp(req.user.id, body.code);
    } else if (body.method === 'recovery') {
      if (!body.code) throw new BadRequestException('code required');
      const outcome = await this.mfa.consumeRecoveryCode(req.user.id, body.code);
      ok = outcome.used;
      if (ok) {
        await this.audit.record({
          actorUserId: req.user.id,
          domain: 'credentials',
          action: 'mfa.recovery.used',
          targetType: 'User',
          targetId: req.user.id,
          result: AuditResult.SUCCESS,
          metadata: { index: outcome.index },
          ...requestContext(req),
        });
      }
    } else {
      throw new BadRequestException('Unsupported method');
    }
    if (!ok) {
      await this.audit.record({
        actorUserId: req.user.id,
        domain: 'credentials',
        action: 'vault.unlock',
        targetType: 'User',
        targetId: req.user.id,
        result: AuditResult.FAILED,
        metadata: { method: body.method },
        ...requestContext(req),
      });
      throw new ForbiddenException('MFA verification failed.');
    }
    const ctx = requestContext(req);
    const issued = await this.sessions.issue({
      userId: req.user.id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    this.setSessionCookie(res, issued.token, issued.expiresAt);
    await this.audit.record({
      actorUserId: req.user.id,
      domain: 'credentials',
      action: 'vault.unlock',
      targetType: 'VaultSession',
      targetId: issued.id,
      result: AuditResult.SUCCESS,
      metadata: { method: body.method },
      ...ctx,
    });
    return { expiresAt: issued.expiresAt };
  }

  @Post('lock')
  @RequirePermission('credentials:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the current vault session immediately.' })
  async lock(
    @Req() req: Request & { user: AuthUser },
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = req.cookies?.[VAULT_SESSION_COOKIE];
    const session = await this.sessions.peek(token, req.user.id);
    if (session) {
      await this.sessions.revoke(session.id, 'user_lock');
      await this.audit.record({
        actorUserId: req.user.id,
        domain: 'credentials',
        action: 'vault.lock',
        targetType: 'VaultSession',
        targetId: session.id,
        result: AuditResult.SUCCESS,
        ...requestContext(req),
      });
    }
    this.clearSessionCookie(res);
    return { ok: true };
  }

  // ─── Passkey / WebAuthn registration ────────────────────────────

  @Post('mfa/passkey/register/options')
  @RequirePermission('credentials:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return WebAuthn registration options (attestation).' })
  async passkeyRegisterOptions(@Req() req: Request & { user: AuthUser }) {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.id },
      select: { firstName: true, lastName: true, email: true },
    });
    const label = user?.email ?? `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() ?? req.user.id;
    return this.mfa.beginPasskeyRegistration(req.user.id, label || req.user.id);
  }

  @Post('mfa/passkey/register/verify')
  @RequirePermission('credentials:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm WebAuthn registration; stores the credential.' })
  async passkeyRegisterVerify(
    @Body() body: PasskeyRegisterDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    if (!body?.response) throw new BadRequestException('response required');
    await this.mfa.completePasskeyRegistration(
      req.user.id,
      body.response,
      body.deviceLabel,
    );
    await this.audit.record({
      actorUserId: req.user.id,
      domain: 'credentials',
      action: 'mfa.passkey.register',
      targetType: 'User',
      targetId: req.user.id,
      result: AuditResult.SUCCESS,
      metadata: { deviceLabel: body.deviceLabel?.slice(0, 60) ?? null },
      ...requestContext(req),
    });
    return { ok: true };
  }

  @Post('mfa/passkey/assert/options')
  @RequirePermission('credentials:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return WebAuthn assertion options (used by unlock).' })
  async passkeyAssertOptions(@Req() req: Request & { user: AuthUser }) {
    return this.mfa.beginPasskeyAssertion(req.user.id);
  }

  // ─── TOTP setup ─────────────────────────────────────────────────

  @Post('mfa/totp/enroll')
  @RequirePermission('credentials:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start TOTP enrollment; returns otpauth URL and seed.' })
  async totpEnroll(@Req() req: Request & { user: AuthUser }) {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true, firstName: true, lastName: true },
    });
    const label = user?.email ?? `${user?.firstName} ${user?.lastName}`.trim() ?? req.user.id;
    return this.mfa.beginTotpEnrollment(req.user.id, label);
  }

  @Post('mfa/totp/confirm')
  @RequirePermission('credentials:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm TOTP with the first live 6-digit code.' })
  async totpConfirm(
    @Body() body: TotpConfirmDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    if (!body?.code) throw new BadRequestException('code required');
    await this.mfa.completeTotpEnrollment(req.user.id, body.code);
    await this.audit.record({
      actorUserId: req.user.id,
      domain: 'credentials',
      action: 'mfa.totp.enrolled',
      targetType: 'User',
      targetId: req.user.id,
      result: AuditResult.SUCCESS,
      ...requestContext(req),
    });
    return { ok: true };
  }

  @Delete('mfa/totp')
  @RequirePermission('credentials:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Remove the caller's TOTP enrollment, gated by a live 6-digit code.",
  })
  async totpRemove(
    @Body() body: TotpConfirmDto,
    @Req() req: Request & { user: AuthUser },
  ) {
    if (!body?.code) throw new BadRequestException('code required');
    await this.mfa.removeTotp(req.user.id, body.code);
    await this.audit.record({
      actorUserId: req.user.id,
      domain: 'credentials',
      action: 'mfa.totp.removed',
      targetType: 'User',
      targetId: req.user.id,
      result: AuditResult.SUCCESS,
      ...requestContext(req),
    });
    return { ok: true };
  }

  // ─── Recovery codes ─────────────────────────────────────────────

  @Post('mfa/recovery/generate')
  @RequirePermission('credentials:view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mint a fresh set of 10 recovery codes. Existing set is wiped.',
  })
  async recoveryGenerate(@Req() req: Request & { user: AuthUser }) {
    const codes = await this.mfa.issueRecoveryCodes(req.user.id);
    await this.audit.record({
      actorUserId: req.user.id,
      domain: 'credentials',
      action: 'mfa.recovery.generated',
      targetType: 'User',
      targetId: req.user.id,
      result: AuditResult.SUCCESS,
      metadata: { count: codes.length },
      ...requestContext(req),
    });
    return { codes };
  }

  // ─── Cookie helpers ─────────────────────────────────────────────

  private setSessionCookie(res: Response, token: string, expiresAt: Date) {
    res.cookie(VAULT_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  }

  private clearSessionCookie(res: Response) {
    res.clearCookie(VAULT_SESSION_COOKIE, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
  }
}
